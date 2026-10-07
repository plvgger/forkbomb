import type { ForkResult } from "../agent.js";
import { BRAND, DEFAULT_HOSTED_URL, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "../brand.js";
import type { EventBus } from "../events.js";
import type { ToolOutcome, Workspace } from "../tools.js";
import type { Semaphore } from "../util.js";

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
}

export interface HostedMe {
  workspace: { id: string; label: string | null; createdAt: string };
  credits: { balanceMicroUsd: number; balanceUsd: number };
  pricing: { inputPerMTokUsd: number; outputPerMTokUsd: number; model: string };
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
  /** Retries for 429, 5xx, a transient 503 (busy or warming up) and network errors. Default 4. */
  maxRetries?: number;
  /** First backoff step; doubles each retry. Default 1000 ms. */
  retryBaseMs?: number;
  /** Per-request ceiling. Default 10 minutes. */
  requestTimeoutMs?: number;
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
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatTurn> {
    // The server picks the model; "hosted" just says "whatever you serve".
    const body = { model: "hosted", messages: req.messages, tools: req.tools, tool_choice: "auto", stream: false };
    const { json, headers } = await this.request("POST", "/chat/completions", body, signal);
    const completion = json as ChatCompletion;
    if (!completion || !Array.isArray(completion.choices)) throw new HostedError("bad_response", 200, "the hosted gateway returned a response without choices");
    const raw = headers.get("x-request-cost-usd");
    const cost = raw === null ? Number.NaN : Number(raw);
    return { completion, costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null };
  }

  async me(signal?: AbortSignal): Promise<HostedMe> {
    const { json } = await this.request("GET", "/me", undefined, signal ?? new AbortController().signal);
    const me = json as HostedMe;
    if (!me?.workspace?.id || typeof me.credits?.balanceMicroUsd !== "number") {
      throw new HostedError("bad_response", 200, "the hosted gateway returned an unexpected /me response");
    }
    return me;
  }

  /** Strip the key out of anything that might end up in an event, a log line or an error. */
  redact(s: string): string {
    return this.#key ? s.split(this.#key).join("[redacted]") : s;
  }

  private async request(method: string, path: string, body: unknown, signal: AbortSignal): Promise<{ json: unknown; headers: Headers }> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw stopped(signal);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#key}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
          redirect: "error",
        });
      } catch (e) {
        if (signal.aborted) throw stopped(signal);
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt), signal);
          continue;
        }
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const why = cause?.code ?? cause?.message ?? (e as Error).message;
        throw new HostedError("network", 0, this.redact(`can't reach the hosted gateway at ${new URL(url).host} (${why})`));
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return { json: JSON.parse(text) as unknown, headers: res.headers };
        } catch {
          throw new HostedError("bad_response", res.status, "the hosted gateway returned invalid JSON");
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

async function readError(res: Response): Promise<{ message: string; code: string }> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    const e = j.error ?? {};
    return {
      message: typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : "",
    };
  } catch {
    return { message: text.slice(0, 300), code: "" };
  }
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
  let summary = "";
  let callSeq = 0;
  const clean = (s: string) => cfg.client.redact?.(s) ?? s;

  const finish = (reason: ForkResult["reason"], error?: string): ForkResult => ({
    reason,
    turns,
    inputTokens,
    outputTokens,
    costUsd: cost,
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
    if (signal.aborted) return finish(cfg.abortReason());
    if (e instanceof HostedError) {
      if (e.kind === "credits" && !credit.exhausted) credit.exhausted = clean(e.message);
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
