import type { ForkResult } from "../agent.js";
import { BRAND, DEFAULT_HOSTED_URL, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "../brand.js";
import type { EventBus } from "../events.js";
import type { ToolOutcome, Workspace } from "../tools.js";
import type { Semaphore } from "../util.js";
import { ChatAssembler, HEADER_COST, HEADER_REMAINING, SseParser, errorFields, utf8Bytes } from "./hosted-stream.js";

/**
 * Fork engine that runs on hosted compute: an OpenAI-compatible Chat
 * Completions gateway paid for with credit from burned tokens. The model only
 * talks; every tool call still runs here, through the same Workspace (Seatbelt
 * sandbox + path confinement) as the API engine. The API key goes to the
 * gateway in the Authorization header and nowhere else.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  tools: typeof HOSTED_TOOLS;
}

export interface ChatCompletion {
  id?: string;
  model?: string;
  choices: Array<{
    index?: number;
    message: { role?: "assistant"; content?: string | null; tool_calls?: Partial<ToolCall>[]; reasoning_content?: string | null };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ChatTurn {
  completion: ChatCompletion;
  /** What the gateway charged for this call (x-request-cost-usd), or null if it didn't say. */
  costUsd: number | null;
  /** Spendable balance after this call (x-credits-remaining-usd), or null if the gateway didn't say. */
  remainingUsd: number | null;
}

export interface HostedPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export interface HostedMe {
  workspace: { id: string; label: string | null; createdAt: string };
  credits: { balanceMicroUsd: number; balanceUsd: number };
  pricing: HostedPricing & { model: string };
}

/** The seam between a hosted fork and the gateway. Tests point a real client at a local mock. */
export interface HostedChat {
  /** Shown in run_start, e.g. "hosted (example.com)". Never contains the key. */
  readonly label: string;
  /** Where people top up: <site>/app. */
  readonly topUpUrl: string;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatTurn>;
  /** Scrub the key from a string before it reaches an event or a log line. */
  redact?(s: string): string;
  /** Spendable balance in micro-USD (GET /me), so a run can report what it was really charged. */
  balance?(signal: AbortSignal): Promise<number>;
}

/** Two function tools that map one-to-one onto Workspace.bash and Workspace.edit. */
export const HOSTED_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description:
        "Run a shell command in a fresh bash shell at the repository root (/workspace). Returns combined stdout/stderr and the exit code. `cd` does not carry over between calls.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The command to run." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit",
      description:
        "View, create and edit files under /workspace. view: show a file with line numbers (or list a directory). create: write file_text to a new or existing file. str_replace: replace old_str, which must match exactly once, with new_str. insert: insert new_str after line insert_line (0 = top of file).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", enum: ["view", "create", "str_replace", "insert"] },
          path: { type: "string", description: "Absolute path under /workspace." },
          file_text: { type: "string", description: "create: the full file contents." },
          old_str: { type: "string", description: "str_replace: exact text to replace." },
          new_str: { type: "string", description: "str_replace: replacement text. insert: text to insert." },
          insert_line: { type: "integer", description: "insert: line number to insert after." },
          view_range: {
            type: "array",
            items: { type: "integer" },
            description: "view: [start, end] line numbers, 1-based; end -1 means to the end of the file.",
          },
        },
        required: ["command", "path"],
      },
    },
  },
];

export type HostedErrorKind = "credits" | "auth" | "rate" | "unavailable" | "network" | "http" | "bad_response";

export class HostedError extends Error {
  /** What the gateway still charged for the failed call: a stream that fails midway is billed for what it generated. */
  costUsd: number | null = null;
  /** costUsd is this client's estimate of the gateway's bill (a stream it hung up on), not a settled figure. */
  costEstimated = false;

  constructor(
    readonly kind: HostedErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HostedSettings {
  baseUrl: string;
  apiKey: string | null;
}

/** Read the hosted engine's settings from the environment (call the .env loader first). Blank values count as unset. */
export function hostedSettings(env: NodeJS.ProcessEnv = process.env): HostedSettings {
  const baseUrl = env[HOSTED_URL_ENV]?.trim() || DEFAULT_HOSTED_URL;
  const apiKey = env[HOSTED_KEY_ENV]?.trim() || null;
  return { baseUrl, apiKey };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Parse and check a base URL: https, or http only to this machine, so the key never crosses the network in clear text. */
export function checkBaseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${HOSTED_URL_ENV} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`${HOSTED_URL_ENV} must use https (plain http is allowed only for localhost): ${raw}`);
  }
  if (u.username || u.password) throw new Error(`${HOSTED_URL_ENV} must not carry credentials`);
  return u;
}

/** <site>/api/v1 -> <site>, so messages can point at <site>/app. */
function siteOf(base: URL): string {
  const path = base.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base.origin}${path}`;
}

export interface HostedClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Retries for 429, 5xx, a transient 503 (busy or warming up), network errors and refunded streams (see request). Default 4. */
  maxRetries?: number;
  /** First backoff step; doubles each retry. Default 1000 ms. */
  retryBaseMs?: number;
  /** Per-request ceiling, streamed body included. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** After a mid-stream error, how long to wait for the gateway's settlement of the failed call. Default 2000 ms. */
  errorGraceMs?: number;
  /** Per-token prices, if already known; me() fills them in. Needed to price a turn this client hangs up on. */
  pricing?: HostedPricing;
}

const RETRYABLE = new Set([429, 500, 502, 504]);

/**
 * The gateway answers 503 both when the pool is not provisioned (permanent: fail fast) and when it is at
 * capacity or warming up (transient). It marks the transient ones with Retry-After, and "at capacity" with
 * the code upstream_busy.
 */
const transient503 = (status: number, headers: Headers, code: string) =>
  status === 503 && (code === "upstream_busy" || headers.has("retry-after"));

export class HostedClient implements HostedChat {
  readonly baseUrl: string;
  readonly site: string;
  readonly label: string;
  readonly topUpUrl: string;
  readonly #key: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly errorGraceMs: number;
  /** From the last /me (or the constructor). Without it, a turn this client hangs up on is priced as unknown. */
  pricing: HostedPricing | null;

  constructor(o: HostedClientOptions) {
    const u = checkBaseUrl(o.baseUrl);
    this.baseUrl = u.href.replace(/\/+$/, "");
    this.site = siteOf(u);
    this.label = `hosted (${u.host})`;
    this.topUpUrl = `${this.site}/app`;
    this.#key = o.apiKey;
    this.maxRetries = o.maxRetries ?? 4;
    this.retryBaseMs = o.retryBaseMs ?? 1000;
    this.requestTimeoutMs = o.requestTimeoutMs ?? 600_000;
    this.errorGraceMs = o.errorGraceMs ?? 2000;
    this.pricing = o.pricing ?? null;
  }

  /**
   * One model turn, streamed. Streaming is what makes a kill cheap: aborting `signal` drops the connection
   * mid-answer, and the gateway stops the GPU and bills only what was streamed. A non-streaming call runs to
   * completion upstream and is billed in full, even after the fork that asked is gone.
   */
  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatTurn> {
    // The server picks the model; "hosted" just says "whatever you serve".
    const body = {
      model: "hosted",
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    };
    return this.request(
      "POST",
      "/chat/completions",
      body,
      signal,
      (res, live) => (isEventStream(res) ? this.readStream(res, live, signal, body) : readCompletion(res)),
      "text/event-stream",
    );
  }

  async me(signal?: AbortSignal): Promise<HostedMe> {
    const me = (await this.request("GET", "/me", undefined, signal ?? new AbortController().signal, readJson)) as HostedMe;
    if (!me?.workspace?.id || typeof me.credits?.balanceMicroUsd !== "number") {
      throw new HostedError("bad_response", 200, "the hosted gateway returned an unexpected /me response");
    }
    const { inputPerMTokUsd: i, outputPerMTokUsd: o } = me.pricing ?? {};
    if (typeof i === "number" && typeof o === "number" && i >= 0 && o >= 0) this.pricing = { inputPerMTokUsd: i, outputPerMTokUsd: o };
    return me;
  }

  async balance(signal: AbortSignal): Promise<number> {
    return (await this.me(signal)).credits.balanceMicroUsd;
  }

  /** Strip the key out of anything that might end up in an event, a log line or an error. */
  redact(s: string): string {
    return this.#key ? s.split(this.#key).join("[redacted]") : s;
  }

  /**
   * Sends one request, retrying what is worth retrying, and hands a 2xx response to `read`. Once the gateway
   * answers 2xx it has reserved credit and started the model, so a body that fails partway is never sent again.
   * The one exception is a stream the gateway refunded in full before the model produced anything (`Refunded`):
   * that is retried like the HTTP 503 or 504 it would have been had the headers not gone out yet.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    read: (res: Response, live: AbortSignal) => Promise<T>,
    accept = "application/json",
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw stopped(signal);
      // The caller's signal or this attempt's ceiling, whichever fires first; it covers the body as well.
      const live = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#key}`,
            accept,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: live,
          redirect: "error",
        });
      } catch (e) {
        if (signal.aborted) throw stopped(signal);
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt), signal);
          continue;
        }
        throw new HostedError("network", 0, this.redact(`can't reach the hosted gateway at ${new URL(url).host} (${why(e)})`));
      }

      if (res.ok) {
        try {
          return await read(res, live);
        } catch (e) {
          if (!(e instanceof Refunded)) throw e;
          if (attempt < this.maxRetries) {
            await sleep(this.backoff(attempt), signal);
            continue;
          }
          const err = this.toError(e.status, e.failure, attempt, true);
          err.costUsd = 0;
          throw err;
        }
      }

      const err = await readError(res);
      const transient = transient503(res.status, res.headers, err.code);
      if ((RETRYABLE.has(res.status) || transient) && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res.headers) ?? this.backoff(attempt), signal);
        continue;
      }
      throw this.toError(res.status, err, attempt, transient);
    }
  }

  /**
   * Reads the gateway's server-sent events into one turn. An abort cancels the pending read at once rather
   * than at the next chunk, so a killed fork's connection closes immediately and the gateway sees it go.
   */
  private async readStream(res: Response, live: AbortSignal, signal: AbortSignal, body: HungUpBody): Promise<ChatTurn> {
    const reader = (res.body ?? new Response("").body!).getReader();
    const decoder = new TextDecoder();
    const sse = new SseParser();
    const chat = new ChatAssembler();
    let halt: (reason: unknown) => void = () => {};
    const halted = new Promise<never>((_, fail) => (halt = fail));
    halted.catch(() => {});
    const onAbort = () => {
      halt(live.reason);
      reader.cancel().catch(() => {});
    };
    // Hanging up on a stream the gateway already answered doesn't make it free: the gateway bills what it had
    // produced by then (and the prompt), settling after the client is gone, where no settlement comment can reach
    // it. So the error carries this client's estimate of that bill, worked out the way the gateway works it out.
    const fail = (e: unknown): Error => {
      const err = signal.aborted
        ? stopped(signal)
        : live.aborted
          ? new HostedError("network", 0, `the hosted gateway didn't finish answering within ${Math.round(this.requestTimeoutMs / 1000)}s`)
          : new HostedError("network", 0, this.redact(`the hosted gateway stream broke off (${why(e)})`));
      const settled = chat.costUsd;
      const estimate = settled === null && this.pricing ? hungUpCostUsd(body, chat, this.pricing) : null;
      return Object.assign(err, { costUsd: settled ?? estimate, costEstimated: settled === null });
    };
    if (live.aborted) onAbort();
    else live.addEventListener("abort", onAbort, { once: true });
    // A mid-stream error is still billed for what was generated, and the gateway settles it just after the
    // error event. Read on briefly for that settlement, then hang up even if the server doesn't.
    let failure: ReturnType<ChatAssembler["event"]> = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      for (let ended = false; !ended && !chat.done && !(failure && chat.costUsd !== null); ) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await Promise.race([reader.read(), halted]);
        } catch (e) {
          if (failure && !live.aborted) break; // no settlement within the grace
          throw fail(e);
        }
        // A cancelled reader reads as a clean end: the signal says whether it was one.
        if (live.aborted) throw fail(live.reason);
        ended = read.done;
        const text = read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
        for (const item of ended ? [...sse.push(text), ...sse.end()] : sse.push(text)) {
          if ("comment" in item) {
            chat.comment(item.comment);
            continue;
          }
          const err = chat.event(item.data);
          if (err && !failure) {
            failure = err;
            grace = setTimeout(() => halt(new Error("no settlement")), this.errorGraceMs);
          }
          if (chat.done) break;
        }
      }
    } finally {
      clearTimeout(grace);
      live.removeEventListener("abort", onAbort);
      // After [DONE] the server ends the body on its own, and leaving that to it keeps the connection
      // reusable for the next turn (the ceiling still bounds one that never ends). Any other early stop
      // (an error event, an abort) hangs up.
      if (chat.done && !failure) reader.releaseLock();
      else reader.cancel().catch(() => {});
    }
    if (failure) {
      // Mid-stream errors read like the HTTP error they stand for. The gateway sends its headers after a few seconds
      // without output, to hold the connection through a cold start, so a job still queued when its time ran out, or
      // a pool busy or warming up, arrives here instead of as an HTTP 503 or 504. Refunded in full with nothing
      // produced, it is retried like one; anything the model produced was billed, and is never sent again.
      const status = statusOf(failure);
      if (chat.costUsd === 0 && !chat.generated && (RETRYABLE.has(status) || status === 503)) throw new Refunded(status, failure);
      const err = this.toError(status, failure, 0, true);
      err.costUsd = chat.costUsd;
      throw err;
    }
    // An answer is whole only once it says why it stopped. [DONE] alone does not make it so: the gateway ends every
    // stream with one, even when its upstream broke off mid-answer. A stream with no answer at all ends below as "no choices".
    if (!chat.finished && (chat.started || !chat.done)) {
      const err = new HostedError("network", 0, "the hosted gateway stream ended before the answer was complete");
      err.costUsd = chat.costUsd;
      throw err;
    }
    return {
      completion: chat.completion(),
      costUsd: chat.costUsd ?? usdHeader(res.headers, HEADER_COST, 0),
      remainingUsd: chat.remainingUsd ?? usdHeader(res.headers, HEADER_REMAINING),
    };
  }

  private backoff(attempt: number): number {
    const step = this.retryBaseMs * 2 ** attempt;
    return Math.min(30_000, step / 2 + Math.random() * (step / 2));
  }

  private toError(status: number, err: { message: string; code: string }, retries: number, transient = false): HostedError {
    const detail = this.redact(err.message || err.code || `HTTP ${status}`).slice(0, 300);
    switch (status) {
      case 401:
        return new HostedError(
          "auth",
          status,
          `the hosted gateway rejected your API key (${err.code || "invalid_api_key"}). Check ${HOSTED_KEY_ENV}, or create a new key at ${this.topUpUrl}.`,
        );
      case 402:
        return new HostedError("credits", status, `out of credit: burn $${BRAND.ticker} to top up at ${this.topUpUrl} (${detail})`);
      case 429:
        return new HostedError("rate", status, `rate limited by the hosted gateway${retries ? ` after ${retries} retries` : ""} (${detail})`);
      case 503:
        if (transient) {
          const what = err.code === "upstream_busy" ? "at capacity" : "warming up or unreachable";
          return new HostedError(
            "unavailable",
            status,
            `the hosted pool is ${what}${retries ? ` after ${retries} retries` : ""} (${err.code || "upstream_unavailable"}: ${detail}). Try again shortly, or use --engine api or --engine claude-code.`,
          );
        }
        return new HostedError(
          "unavailable",
          status,
          `the hosted pool is unavailable (${err.code || "upstream_unavailable"}: ${detail}). Use --engine api or --engine claude-code for now.`,
        );
      default:
        return new HostedError("http", status, `hosted gateway error ${status}${err.code ? ` ${err.code}` : ""}: ${detail}`);
    }
  }
}

/** The parts of a chat request the gateway's input estimate reads. */
type HungUpBody = { messages: unknown[]; tools?: unknown; tool_choice?: unknown };

/** The gateway's billing constants for a stream it settles itself (web/lib/server/gateway/request.ts). */
const BYTES_PER_TOKEN = 3;
const BASE_TOKENS = 16;
const PER_MESSAGE_TOKENS = 8;

/**
 * What the gateway bills for a streamed turn the client hung up on: the usage chunk if it had arrived, otherwise
 * its input estimate (everything the model reads, at BYTES_PER_TOKEN, plus fixed overheads) and the output that had
 * streamed (bytes at BYTES_PER_TOKEN, at least a token per delta), at the per-token prices, rounded up to a
 * micro-USD. Only what reached this client is counted, so a few deltas still in flight can be missed.
 */
export function hungUpCostUsd(body: HungUpBody, chat: ChatAssembler, pricing: HostedPricing): number {
  const u = chat.usage;
  const real = Number.isSafeInteger(u?.prompt_tokens) && Number.isSafeInteger(u?.completion_tokens);
  const input = real
    ? u!.prompt_tokens!
    : BASE_TOKENS +
      body.messages.length * PER_MESSAGE_TOKENS +
      Math.ceil(utf8Bytes(JSON.stringify([body.messages, body.tools ?? null, body.tool_choice ?? null, null])) / BYTES_PER_TOKEN);
  const output = real ? u!.completion_tokens! : Math.max(chat.generatedChunks, Math.ceil(chat.generatedBytes / BYTES_PER_TOKEN));
  const micro = Math.ceil((input * Math.round(pricing.inputPerMTokUsd * 1e6) + output * Math.round(pricing.outputPerMTokUsd * 1e6)) / 1e6);
  return micro / 1e6;
}

/**
 * What a hosted run was really charged: how far the balance fell since `beforeMicro`, once the gateway has settled
 * the turns the run hung up on. Until a hung-up turn settles, its whole reservation is held, so the drop overshoots
 * for a moment; this polls until the drop comes within reach of the run's own figure (`local`, which includes the
 * estimates). Null when the balance can't be read, or never fits (a top-up landed, or another client spent on the
 * same key at the same time), in which case the local figure stands.
 */
export async function chargedSince(
  client: HostedChat,
  beforeMicro: number,
  local: { usd: number; estimatedUsd: number },
  opts: { waitMs?: number; everyMs?: number; signal?: AbortSignal } = {},
): Promise<number | null> {
  if (!client.balance) return null;
  const settled = local.usd - local.estimatedUsd;
  const lo = settled + local.estimatedUsd / 2;
  const hi = local.usd + local.estimatedUsd / 2 + 0.0005;
  const deadline = performance.now() + (opts.waitMs ?? 6000);
  for (;;) {
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 750));
    if (opts.signal?.aborted) return null; // interrupted: the estimate will do
    const now = await client.balance(AbortSignal.timeout(8000)).catch(() => null);
    if (now === null) return null;
    const drop = (beforeMicro - now) / 1e6;
    if (drop >= lo - 1e-9 && drop <= hi + 1e-9) return Math.round(drop * 1e6) / 1e6;
    if (drop < lo || performance.now() > deadline) return null;
  }
}

/** A streamed call that failed before the model produced anything, and that the gateway refunded in full. request() sends it again. */
class Refunded extends Error {
  constructor(
    readonly status: number,
    readonly failure: { message: string; code: string },
  ) {
    super(failure.message);
  }
}

async function readError(res: Response): Promise<{ message: string; code: string }> {
  const text = await res.text().catch(() => "");
  try {
    return errorFields(JSON.parse(text)) ?? { message: "", code: "" };
  } catch {
    return { message: text.slice(0, 300), code: "" };
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HostedError("bad_response", res.status, "the hosted gateway returned invalid JSON");
  }
}

/** A server that ignored stream: true and answered with one JSON completion: take it as it is. */
async function readCompletion(res: Response): Promise<ChatTurn> {
  const completion = (await readJson(res)) as ChatCompletion;
  if (!completion || !Array.isArray(completion.choices)) throw new HostedError("bad_response", 200, "the hosted gateway returned a response without choices");
  return { completion, costUsd: usdHeader(res.headers, HEADER_COST, 0), remainingUsd: usdHeader(res.headers, HEADER_REMAINING) };
}

const isEventStream = (res: Response) => /^text\/event-stream\b/i.test(res.headers.get("content-type") ?? "");

/** A mid-stream error event carries no HTTP status: recover the one the gateway would have answered with. */
function statusOf(err: { code: string; type: string }): number {
  switch (err.type) {
    case "authentication_error":
      return 401;
    case "billing_error":
      return 402;
    case "rate_limit_error":
      return 429;
    case "invalid_request_error":
      return 400;
  }
  if (err.code === "upstream_busy" || err.code === "upstream_unavailable") return 503;
  if (err.code === "upstream_timeout") return 504;
  return 502;
}

/** A USD amount from a header, or null if it is missing, not a number, or below `min`. */
function usdHeader(h: Headers, name: string, min = Number.NEGATIVE_INFINITY): number | null {
  const raw = h.get(name);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? n : null;
}

/** The most specific reason a fetch or a body read failed (ECONNRESET beats "fetch failed"). */
function why(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } } | null)?.cause;
  return cause?.code ?? cause?.message ?? (e as Error | null)?.message ?? String(e);
}

function retryAfterMs(h: Headers): number | null {
  const v = h.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(60_000, s * 1000) : null;
}

/** Why the caller's signal fired: its own deadline reads as a network error, anything else is an abort. */
function stopped(signal: AbortSignal): Error {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError" ? new HostedError("network", 0, "the hosted gateway didn't answer in time") : abortError();
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(stopped(signal));
    const onAbort = () => {
      clearTimeout(t);
      fail(stopped(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Shared by every fork in a run: the first fork to hit 402 records why, and no other fork makes another call. */
export interface CreditGate {
  exhausted: string | null;
}

export interface HostedForkConfig {
  id: string;
  workspace: Workspace;
  client: HostedChat;
  system: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
  abortReason: () => "killed" | "timeout";
  bus: EventBus;
  apiSlots: Semaphore;
  credit: CreditGate;
}

/** One hosted fork: a Chat Completions tool-calling loop over bash and edit, inside its own clone. */
export async function runHostedFork(cfg: HostedForkConfig): Promise<ForkResult> {
  const { bus, id, signal, workspace, credit } = cfg;
  const messages: ChatMessage[] = [
    { role: "system", content: cfg.system },
    { role: "user", content: cfg.prompt },
  ];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = 0;
  let estimated = 0;
  let summary = "";
  let callSeq = 0;
  const clean = (s: string) => cfg.client.redact?.(s) ?? s;

  const finish = (reason: ForkResult["reason"], error?: string): ForkResult => ({
    reason,
    turns,
    inputTokens,
    outputTokens,
    costUsd: cost,
    ...(cost !== null && estimated > 0 ? { costEstimatedUsd: Math.round(estimated * 1e6) / 1e6 } : {}),
    summary,
    ...(error ? { error: clean(error) } : {}),
  });

  try {
    while (true) {
      if (signal.aborted) return finish(cfg.abortReason());
      if (credit.exhausted) return finish("error", credit.exhausted);
      if (turns >= cfg.maxTurns) return finish("max_turns");

      const release = await cfg.apiSlots.acquire();
      let turn: ChatTurn;
      try {
        if (signal.aborted) return finish(cfg.abortReason());
        // Another fork may have run the workspace dry while this one waited for a slot.
        if (credit.exhausted) return finish("error", credit.exhausted);
        turns++;
        turn = await cfg.client.chat({ messages, tools: HOSTED_TOOLS }, signal);
      } finally {
        release();
      }

      const u = turn.completion.usage ?? {};
      inputTokens += u.prompt_tokens ?? 0;
      outputTokens += u.completion_tokens ?? 0;
      cost = cost === null || turn.costUsd === null ? null : cost + turn.costUsd;

      const choice = turn.completion.choices[0];
      if (!choice) return finish("error", "the hosted gateway returned no choices");
      const m = choice.message ?? {};
      const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
      if (reasoning) bus.emit({ type: "note", fork: id, text: reasoning.slice(0, 280) });
      const content = typeof m.content === "string" ? m.content : null;
      if (content?.trim()) {
        summary = content.trim();
        bus.emit({ type: "note", fork: id, text: summary.slice(0, 280) });
      }

      // Every call needs an id for its result to point at; fill one in if the server left it out.
      const calls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c) => ({
        id: typeof c.id === "string" && c.id ? c.id : `call_${id}_${++callSeq}`,
        type: "function",
        function: { name: String(c.function?.name ?? ""), arguments: typeof c.function?.arguments === "string" ? c.function.arguments : "" },
      }));

      // Append-only history: the assistant turn goes back as it came.
      messages.push(calls.length ? { role: "assistant", content, tool_calls: calls } : { role: "assistant", content: content ?? "" });

      if (choice.finish_reason === "content_filter") return finish("refusal");

      const cut = choice.finish_reason === "length";
      if (calls.length === 0) {
        if (cut) {
          messages.push({ role: "user", content: "You hit the output limit. Continue, and keep each edit smaller." });
          continue;
        }
        return finish("end_turn");
      }

      for (const call of calls) {
        if (signal.aborted || cut) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: signal.aborted ? "error: aborted" : "error: this call was cut off by the output limit. Retry it with a smaller input.",
          });
          continue;
        }
        const t0 = performance.now();
        const out = await runTool(workspace, call, signal);
        bus.emit({
          type: "tool",
          fork: id,
          tool: call.function.name === "edit" ? "edit" : "bash",
          summary: clean(out.summary),
          ok: !out.isError,
          ms: Math.round(performance.now() - t0),
        });
        const text = out.isError && call.function.name !== "bash" ? `error: ${out.text}` : out.text;
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
    }
  } catch (e) {
    // A turn that ended early can still have been charged: settled by the gateway, or estimated by the client
    // when it hung up (killed, timed out, connection lost). An estimate it couldn't make means the cost is unknown.
    const charge = e as { costUsd?: number | null; costEstimated?: boolean };
    if (typeof charge.costUsd === "number") {
      if (cost !== null) cost += charge.costUsd;
      if (charge.costEstimated) estimated += charge.costUsd;
    } else if (charge.costEstimated) cost = null;
    if (signal.aborted) return finish(cfg.abortReason());
    if (e instanceof HostedError) {
      if (e.kind === "credits" && !credit.exhausted) credit.exhausted = clean(e.message);
      if (e.kind === "auth") return { ...finish("error", e.message), fatal: clean(e.message) };
      return finish("error", e.message);
    }
    return finish("error", e instanceof Error ? e.message : String(e));
  }
}

async function runTool(workspace: Workspace, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
  const name = call.function.name;
  if (name !== "bash" && name !== "edit") {
    return { text: `unknown tool ${JSON.stringify(name)}; the tools are bash and edit`, isError: true, summary: name || "unknown tool" };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments.trim() || "{}");
  } catch (e) {
    return {
      text: `the arguments for ${name} were not valid JSON (${(e as Error).message}). Send the call again with a single JSON object.`,
      isError: true,
      summary: `${name}: bad arguments`,
    };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { text: `the arguments for ${name} must be a JSON object`, isError: true, summary: `${name}: bad arguments` };
  }
  return name === "bash" ? workspace.bash(args, signal) : workspace.edit(args);
}

/** Human-readable balance and pricing, for `forkbomb credits` and `forkbomb doctor`. */
export function formatCredits(me: HostedMe, topUpUrl: string): string {
  const usd = (n: number, d = 2) => `$${n.toFixed(d)}`;
  const label = me.workspace.label ? `${me.workspace.label} (${me.workspace.id})` : me.workspace.id;
  return [
    `workspace  ${label}`,
    `credit     ${usd(me.credits.balanceMicroUsd / 1e6, 4)}`,
    `pricing    ${usd(me.pricing.inputPerMTokUsd)} / 1M input tokens · ${usd(me.pricing.outputPerMTokUsd)} / 1M output tokens · model ${me.pricing.model}`,
    `top up     burn $${BRAND.ticker} at ${topUpUrl}`,
  ].join("\n");
}
