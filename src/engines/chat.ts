import type { ForkResult } from "../agent.js";
import type { EventBus } from "../events.js";
import type { ToolOutcome, Workspace } from "../tools.js";
import type { Semaphore } from "../util.js";
import { ChatAssembler, HEADER_COST, HEADER_REMAINING, SseParser, errorFields } from "./chat-stream.js";

/**
 * Chat Completions over HTTP: the client and the fork loop shared by the engines that speak it, hosted (the
 * forkbomb.fun gateway, src/engines/hosted.ts) and openai (any OpenAI-compatible server, src/engines/openai.ts).
 * The model only talks; every tool call still runs here, through the fork's Workspace (Seatbelt sandbox + path
 * confinement), as on the api engine. A key, if there is one, goes to the configured server in the Authorization
 * header and nowhere else.
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
  tools: typeof CHAT_TOOLS;
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
  /** What the server charged for this call (x-request-cost-usd), or null if it didn't say. */
  costUsd: number | null;
  /** Spendable balance after this call (x-credits-remaining-usd), or null if the server didn't say. */
  remainingUsd: number | null;
}

/** Told how a streamed turn starts: comments before any of the answer mean the server is holding the request in a queue. */
export interface StreamWatch {
  /** A comment (": keep-alive") arrived before the first chunk of the answer. */
  waiting(): void;
  /** The first chunk of the answer arrived. */
  started(): void;
}

/** Shared by every fork in a run: one StreamWatch per model call, ended when the call settles. */
export interface QueueWatch {
  begin(): StreamWatch & { end(): void };
}

/** The seam between a fork and a Chat Completions server. Tests point a real client at a local mock. */
export interface ChatClient {
  /** Shown in run_start, e.g. "hosted (example.com)". Never contains the key. */
  readonly label: string;
  /** What the server bills is out of sight (a local server, or a provider that bills on its own), so every fork's cost is unknown. */
  readonly unpriced?: boolean;
  chat(req: ChatRequest, signal: AbortSignal, watch?: StreamWatch): Promise<ChatTurn>;
  /** Scrub the key from a string before it reaches an event or a log line. */
  redact?(s: string): string;
}

/** Two function tools that map one-to-one onto Workspace.bash and Workspace.edit. */
export const CHAT_TOOLS = [
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

export type ChatErrorKind =
  | "credits"
  | "auth"
  | "rate"
  | "unavailable"
  | "network"
  | "http"
  | "bad_response"
  /** The server doesn't have the model asked for. */
  | "model"
  /** The server or the model can't do tool calls. */
  | "tools"
  /** Nothing answers Chat Completions at that URL. */
  | "endpoint";

/** Errors every fork would hit the same way: the first one stops the run instead of letting each fork find out. */
export const FATAL: ReadonlySet<ChatErrorKind> = new Set<ChatErrorKind>(["auth", "model", "tools", "endpoint"]);

export class ChatError extends Error {
  /** What the server still charged for the failed call: a stream that fails midway is billed for what it generated. */
  costUsd: number | null = null;
  /** costUsd is this client's estimate of the server's bill (a stream it hung up on), not a settled figure. */
  costEstimated = false;
  /** The server's own code and message (key redacted), to tell one 400 from another. */
  serverMessage = "";

  constructor(
    readonly kind: ChatErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Parse and check a base URL: https, or http only to this machine, so the key and the code forks read never cross
 * the network in clear text. `setting` names where the URL came from (an env var or a flag) in the error.
 */
export function checkBaseUrl(raw: string, setting: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${setting} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`${setting} must use https (plain http is allowed only for localhost): ${raw}`);
  }
  if (u.username || u.password) throw new Error(`${setting} must not carry credentials`);
  return u;
}

export interface ChatHttpOptions {
  baseUrl: string;
  /** Sent as a Bearer token, to baseUrl only. Null sends no Authorization header. */
  apiKey: string | null;
  /** Where baseUrl came from, for errors about it: an env var or a flag. */
  urlSetting: string;
  /** Retries for what retryable() allows, network errors and refunded streams (see request). Default 4. */
  maxRetries?: number;
  /** First backoff step; doubles each retry. Default 1000 ms. */
  retryBaseMs?: number;
  /** Per-request ceiling, streamed body included. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** After a mid-stream error, how long to wait for the server's settlement of the failed call. Default 2000 ms. */
  errorGraceMs?: number;
}

/** The parts of a chat request a hung-up turn's bill is worked out from. */
export type HungUpBody = { messages: unknown[]; tools?: unknown; tool_choice?: unknown };

type ServerError = { message: string; code: string };

/**
 * One Chat Completions server: requests with retries and backoff, streamed answers assembled into one turn, a
 * key that goes to this server only and is redacted from everything it says. Subclasses say how errors read,
 * which ones are worth another try, and what a server-specific settlement means.
 */
export abstract class ChatHttpClient implements ChatClient {
  readonly baseUrl: string;
  /** host[:port], for labels and messages. */
  readonly host: string;
  abstract readonly label: string;
  /** The server as messages name it ("the hosted gateway"). */
  protected abstract readonly server: string;
  /** Its stream as messages name it ("the hosted gateway stream"). */
  protected abstract readonly stream: string;
  readonly #key: string | null;
  protected readonly maxRetries: number;
  protected readonly retryBaseMs: number;
  protected readonly requestTimeoutMs: number;
  protected readonly errorGraceMs: number;

  constructor(o: ChatHttpOptions) {
    const u = checkBaseUrl(o.baseUrl, o.urlSetting);
    this.baseUrl = u.href.replace(/\/+$/, "");
    this.host = u.host;
    this.#key = o.apiKey || null;
    this.maxRetries = o.maxRetries ?? 4;
    this.retryBaseMs = o.retryBaseMs ?? 1000;
    this.requestTimeoutMs = o.requestTimeoutMs ?? 600_000;
    this.errorGraceMs = o.errorGraceMs ?? 2000;
  }

  abstract chat(req: ChatRequest, signal: AbortSignal, watch?: StreamWatch): Promise<ChatTurn>;

  /** Whether a key is sent at all (local servers often need none). */
  get hasKey(): boolean {
    return this.#key !== null;
  }

  /** Strip the key out of anything that might end up in an event, a log line or an error. */
  redact(s: string): string {
    return this.#key ? s.split(this.#key).join("[redacted]") : s;
  }

  /** What the user reads for an error answer: an HTTP status, or the mid-stream error event that stands for one. */
  protected abstract toError(status: number, err: ServerError, retries: number, transient: boolean): ChatError;

  /** Whether an error answer is worth sending again (429, a 5xx). */
  protected abstract retryable(status: number, headers: Headers, err: ServerError): boolean;

  /** "can't reach …": the message once every attempt to connect failed. */
  protected unreachable(why: string): string {
    return `can't reach ${this.server} at ${this.host} (${why})`;
  }

  /** What the server will bill for a streamed turn this client hung up on, if it can be worked out. */
  protected hungUpCost(_body: HungUpBody, _chat: ChatAssembler): number | null {
    return null;
  }

  /** A stream that failed in a way the server refunded in full before the model produced anything: safe to send again. */
  protected refunded(_status: number, _chat: ChatAssembler): boolean {
    return false;
  }

  /**
   * One model turn, streamed. Streaming is what makes a kill cheap: aborting `signal` drops the connection
   * mid-answer, and a server that meters by the token stops there. A server that ignores stream: true and
   * answers with one JSON completion is taken as it is.
   */
  protected streamChat(body: HungUpBody & Record<string, unknown>, signal: AbortSignal, watch?: StreamWatch): Promise<ChatTurn> {
    return this.request(
      "POST",
      "/chat/completions",
      body,
      signal,
      (res, live) => (isEventStream(res) ? this.readStream(res, live, signal, body, watch) : this.readCompletion(res)),
      "text/event-stream",
    );
  }

  /**
   * Sends one request, retrying what is worth retrying, and hands a 2xx response to `read`. Once the server
   * answers 2xx it has started the model, so a body that fails partway is never sent again. The one exception
   * is a stream the server refunded in full before the model produced anything (`Refunded`): that is retried
   * like the HTTP 503 or 504 it would have been had the headers not gone out yet.
   */
  protected async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    read: (res: Response, live: AbortSignal) => Promise<T>,
    accept = "application/json",
    retries = this.maxRetries,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw this.stopped(signal);
      // The caller's signal or this attempt's ceiling, whichever fires first; it covers the body as well.
      const live = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            ...(this.#key ? { authorization: `Bearer ${this.#key}` } : {}),
            accept,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: live,
          redirect: "error",
        });
      } catch (e) {
        if (signal.aborted) throw this.stopped(signal);
        if (attempt < retries) {
          await this.sleep(this.backoff(attempt), signal);
          continue;
        }
        throw new ChatError("network", 0, this.redact(this.unreachable(why(e))));
      }

      if (res.ok) {
        try {
          return await read(res, live);
        } catch (e) {
          if (!(e instanceof Refunded)) throw e;
          if (attempt < retries) {
            await this.sleep(this.backoff(attempt), signal);
            continue;
          }
          const err = this.error(e.status, e.failure, attempt, true);
          err.costUsd = 0;
          throw err;
        }
      }

      const err = await readError(res);
      const retry = this.retryable(res.status, res.headers, err);
      if (retry && attempt < retries) {
        await this.sleep(retryAfterMs(res.headers) ?? this.backoff(attempt), signal);
        continue;
      }
      throw this.error(res.status, err, attempt, retry);
    }
  }

  /** A response body as JSON. */
  protected async json(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ChatError("bad_response", res.status, `${this.server} returned invalid JSON`);
    }
  }

  /**
   * Reads the server's events into one turn. An abort cancels the pending read at once rather than at the next
   * chunk, so a killed fork's connection closes immediately and the server sees it go.
   */
  private async readStream(res: Response, live: AbortSignal, signal: AbortSignal, body: HungUpBody, watch?: StreamWatch): Promise<ChatTurn> {
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
    // Hanging up on a stream the server already answered doesn't make it free: a metered server bills what it had
    // produced by then (and the prompt), settling after the client is gone, where no settlement comment can reach
    // it. So the error carries this client's estimate of that bill, if it can make one.
    const fail = (e: unknown): Error => {
      const err = signal.aborted
        ? this.stopped(signal)
        : live.aborted
          ? new ChatError("network", 0, `${this.server} didn't finish answering within ${Math.round(this.requestTimeoutMs / 1000)}s`)
          : new ChatError("network", 0, this.redact(`${this.stream} broke off (${why(e)})`));
      const settled = chat.costUsd;
      const estimate = settled === null ? this.hungUpCost(body, chat) : null;
      return Object.assign(err, { costUsd: settled ?? estimate, costEstimated: settled === null });
    };
    if (live.aborted) onAbort();
    else live.addEventListener("abort", onAbort, { once: true });
    // A mid-stream error is still billed for what was generated, and a metered server settles it just after the
    // error event. Read on briefly for that settlement, then hang up even if the server doesn't.
    let failure: ReturnType<ChatAssembler["event"]> = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let answering = false;
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
            if (!chat.started) watch?.waiting();
            chat.comment(item.comment);
            continue;
          }
          const err = chat.event(item.data);
          if (!answering && chat.started) {
            answering = true;
            watch?.started();
          }
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
      // Mid-stream errors read like the HTTP error they stand for. Some are refunded in full with nothing produced
      // (see refunded()) and go again; anything the model produced was billed, and is never sent again.
      const status = statusOf(failure);
      if (this.refunded(status, chat)) throw new Refunded(status, failure);
      const err = this.error(status, failure, 0, true);
      err.costUsd = chat.costUsd;
      throw err;
    }
    // An answer is whole only once it says why it stopped. [DONE] alone does not make it so: a gateway can end every
    // stream with one, even when its upstream broke off mid-answer. A stream with no answer at all ends as "no choices".
    if (!chat.finished && (chat.started || !chat.done)) {
      const err = new ChatError("network", 0, `${this.stream} ended before the answer was complete`);
      err.costUsd = chat.costUsd;
      throw err;
    }
    return {
      completion: chat.completion(),
      costUsd: chat.costUsd ?? usdHeader(res.headers, HEADER_COST, 0),
      remainingUsd: chat.remainingUsd ?? usdHeader(res.headers, HEADER_REMAINING),
    };
  }

  /** A server that ignored stream: true and answered with one JSON completion. */
  private async readCompletion(res: Response): Promise<ChatTurn> {
    const completion = (await this.json(res)) as ChatCompletion;
    if (!completion || !Array.isArray(completion.choices)) throw new ChatError("bad_response", 200, `${this.server} returned a response without choices`);
    return { completion, costUsd: usdHeader(res.headers, HEADER_COST, 0), remainingUsd: usdHeader(res.headers, HEADER_REMAINING) };
  }

  /** toError, plus the server's own words for callers that need to tell one error from another. */
  private error(status: number, err: ServerError, retries: number, transient: boolean): ChatError {
    const e = this.toError(status, err, retries, transient);
    e.serverMessage = this.redact(`${err.code} ${err.message}`.trim());
    return e;
  }

  private backoff(attempt: number): number {
    const step = this.retryBaseMs * 2 ** attempt;
    return Math.min(30_000, step / 2 + Math.random() * (step / 2));
  }

  /** Why the caller's signal fired: its own deadline reads as a network error, anything else is an abort. */
  private stopped(signal: AbortSignal): Error {
    const reason = signal.reason as { name?: string } | undefined;
    return reason?.name === "TimeoutError" ? new ChatError("network", 0, `${this.server} didn't answer in time`) : abortError();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((done, fail) => {
      if (signal.aborted) return fail(this.stopped(signal));
      const onAbort = () => {
        clearTimeout(t);
        fail(this.stopped(signal));
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        done();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** A streamed call that failed before the model produced anything, and that the server refunded in full. request() sends it again. */
class Refunded extends Error {
  constructor(
    readonly status: number,
    readonly failure: ServerError,
  ) {
    super(failure.message);
  }
}

async function readError(res: Response): Promise<ServerError> {
  const text = await res.text().catch(() => "");
  try {
    return errorFields(JSON.parse(text)) ?? { message: "", code: "" };
  } catch {
    return { message: text.slice(0, 300), code: "" };
  }
}

const isEventStream = (res: Response) => /^text\/event-stream\b/i.test(res.headers.get("content-type") ?? "");

/** A mid-stream error event carries no HTTP status: recover the one the server would have answered with. */
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

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Shared by every fork in a run: the first fork to run out of credit (402) records why, and no other fork makes another call. */
export interface CreditGate {
  exhausted: string | null;
}

export interface ChatForkConfig {
  id: string;
  workspace: Workspace;
  client: ChatClient;
  system: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
  abortReason: () => "killed" | "timeout";
  bus: EventBus;
  apiSlots: Semaphore;
  credit: CreditGate;
  /** Shared by every fork in a run, to tell the user once that requests are queued (a hosted cold start). */
  queue?: QueueWatch;
}

/** One fork on a Chat Completions server: a tool-calling loop over bash and edit, inside its own clone. */
export async function runChatFork(cfg: ChatForkConfig): Promise<ForkResult> {
  const { bus, id, signal, workspace, credit } = cfg;
  const messages: ChatMessage[] = [
    { role: "system", content: cfg.system },
    { role: "user", content: cfg.prompt },
  ];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = cfg.client.unpriced ? null : 0;
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
      const watch = cfg.queue?.begin();
      try {
        if (signal.aborted) return finish(cfg.abortReason());
        // Another fork may have run the account dry while this one waited for a slot.
        if (credit.exhausted) return finish("error", credit.exhausted);
        turns++;
        turn = await cfg.client.chat({ messages, tools: CHAT_TOOLS }, signal, watch);
      } finally {
        watch?.end();
        release();
      }

      const u = turn.completion.usage ?? {};
      inputTokens += u.prompt_tokens ?? 0;
      outputTokens += u.completion_tokens ?? 0;
      cost = cost === null || turn.costUsd === null ? null : cost + turn.costUsd;

      const choice = turn.completion.choices[0];
      if (!choice) return finish("error", `${cfg.client.label} returned no choices`);
      const m = choice.message ?? {};
      const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
      if (reasoning) bus.emit({ type: "note", fork: id, text: clean(reasoning).slice(0, 280) });
      const content = typeof m.content === "string" ? m.content : null;
      if (content?.trim()) {
        summary = clean(content.trim());
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
    // A turn that ended early can still have been charged: settled by the server, or estimated by the client
    // when it hung up (killed, timed out, connection lost). An estimate it couldn't make means the cost is unknown.
    const charge = e as { costUsd?: number | null; costEstimated?: boolean };
    if (typeof charge.costUsd === "number") {
      if (cost !== null) cost += charge.costUsd;
      if (charge.costEstimated) estimated += charge.costUsd;
    } else if (charge.costEstimated) cost = null;
    if (signal.aborted) return finish(cfg.abortReason());
    if (e instanceof ChatError) {
      if (e.kind === "credits" && !credit.exhausted) credit.exhausted = clean(e.message);
      if (FATAL.has(e.kind)) return { ...finish("error", e.message), fatal: clean(e.message) };
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
