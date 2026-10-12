import { BRAND, DEFAULT_HOSTED_URL, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "../brand.js";
import {
  type ChatClient,
  ChatError,
  type ChatHttpOptions,
  ChatHttpClient,
  type ChatRequest,
  type ChatTurn,
  type HungUpBody,
  type QueueWatch,
  type StreamWatch,
} from "./chat.js";
import { type ChatAssembler, utf8Bytes } from "./chat-stream.js";

/**
 * Fork engine that runs on hosted compute: the forkbomb.fun gateway, an OpenAI-compatible Chat Completions API
 * paid for with credit from burned tokens. The client and the fork loop are the shared ones in chat.ts; this file
 * adds what is particular to the gateway: its errors, its billing (settlements, hung-up turns, the balance) and
 * its cold starts. The API key goes to the gateway in the Authorization header and nowhere else.
 */

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
export interface HostedChat extends ChatClient {
  /** Where people top up: <site>/app. */
  readonly topUpUrl: string;
  /** Spendable balance in micro-USD (GET /me), so a run can report what it was really charged. */
  balance?(signal: AbortSignal): Promise<number>;
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

/** <site>/api/v1 -> <site>, so messages can point at <site>/app. */
function siteOf(base: URL): string {
  const path = base.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${base.origin}${path}`;
}

export interface HostedClientOptions extends Omit<ChatHttpOptions, "apiKey" | "urlSetting"> {
  apiKey: string;
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

export class HostedClient extends ChatHttpClient implements HostedChat {
  readonly site: string;
  readonly label: string;
  readonly topUpUrl: string;
  protected readonly server = "the hosted gateway";
  protected readonly stream = "the hosted gateway stream";
  /** From the last /me (or the constructor). Without it, a turn this client hangs up on is priced as unknown. */
  pricing: HostedPricing | null;

  constructor(o: HostedClientOptions) {
    super({ ...o, urlSetting: HOSTED_URL_ENV });
    this.site = siteOf(new URL(this.baseUrl));
    this.label = `hosted (${this.host})`;
    this.topUpUrl = `${this.site}/app`;
    this.pricing = o.pricing ?? null;
  }

  /**
   * One model turn, streamed: aborting `signal` drops the connection mid-answer, and the gateway stops the GPU and
   * bills only what was streamed. A non-streaming call runs to completion upstream and is billed in full, even after
   * the fork that asked is gone.
   */
  chat(req: ChatRequest, signal: AbortSignal, watch?: StreamWatch): Promise<ChatTurn> {
    // The server picks the model; "hosted" just says "whatever you serve".
    const body = {
      model: "hosted",
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    };
    return this.streamChat(body, signal, watch);
  }

  async me(signal?: AbortSignal): Promise<HostedMe> {
    const me = (await this.request("GET", "/me", undefined, signal ?? new AbortController().signal, (res) => this.json(res))) as HostedMe;
    if (!me?.workspace?.id || typeof me.credits?.balanceMicroUsd !== "number") {
      throw new ChatError("bad_response", 200, "the hosted gateway returned an unexpected /me response");
    }
    const { inputPerMTokUsd: i, outputPerMTokUsd: o } = me.pricing ?? {};
    if (typeof i === "number" && typeof o === "number" && i >= 0 && o >= 0) this.pricing = { inputPerMTokUsd: i, outputPerMTokUsd: o };
    return me;
  }

  async balance(signal: AbortSignal): Promise<number> {
    return (await this.me(signal)).credits.balanceMicroUsd;
  }

  protected retryable(status: number, headers: Headers, err: { code: string }): boolean {
    return RETRYABLE.has(status) || transient503(status, headers, err.code);
  }

  protected hungUpCost(body: HungUpBody, chat: ChatAssembler): number | null {
    return this.pricing ? hungUpCostUsd(body, chat, this.pricing) : null;
  }

  /**
   * The gateway sends its headers after a few seconds without output, to hold the connection through a cold start,
   * so a job still queued when its time ran out, or a pool busy or warming up, arrives as an error event instead of
   * as an HTTP 503 or 504. Settled at zero with nothing produced, it is retried like one.
   */
  protected refunded(status: number, chat: ChatAssembler): boolean {
    return chat.costUsd === 0 && !chat.generated && (RETRYABLE.has(status) || status === 503);
  }

  protected toError(status: number, err: { message: string; code: string }, retries: number, transient: boolean): ChatError {
    const detail = this.redact(err.message || err.code || `HTTP ${status}`).slice(0, 300);
    switch (status) {
      case 401:
        return new ChatError(
          "auth",
          status,
          `the hosted gateway rejected your API key (${err.code || "invalid_api_key"}). Check ${HOSTED_KEY_ENV}, or create a new key at ${this.topUpUrl}.`,
        );
      case 402:
        return new ChatError("credits", status, `out of credit: burn $${BRAND.ticker} to top up at ${this.topUpUrl} (${detail})`);
      case 429:
        return new ChatError("rate", status, `rate limited by the hosted gateway${retries ? ` after ${retries} retries` : ""} (${detail})`);
      case 503:
        if (transient) {
          const what = err.code === "upstream_busy" ? "at capacity" : "warming up or unreachable";
          return new ChatError(
            "unavailable",
            status,
            `the hosted pool is ${what}${retries ? ` after ${retries} retries` : ""} (${err.code || "upstream_unavailable"}: ${detail}). Try again shortly, or use --engine api or --engine claude-code.`,
          );
        }
        return new ChatError(
          "unavailable",
          status,
          `the hosted pool is unavailable (${err.code || "upstream_unavailable"}: ${detail}). Use --engine api or --engine claude-code for now.`,
        );
      default:
        return new ChatError("http", status, `hosted gateway error ${status}${err.code ? ` ${err.code}` : ""}: ${detail}`);
    }
  }
}

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

/** "3m 12s", "45s". */
function waited(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Tells the user, once per run, that hosted requests are queued behind a GPU worker that is still starting. During
 * a cold start the gateway holds each request open with ": keep-alive" comments and no answer. Once a request has
 * waited like that for `afterMs` with no answer yet anywhere in the run, this says so; then about every `everyMs`
 * it says how long the wait has been; when the first answer starts streaming it says so and stops for good. Waits
 * after that are a busy pool, not a cold one, so they are not reported.
 */
export class WarmUpNotice implements QueueWatch {
  readonly #say: (msg: string) => void;
  readonly #afterMs: number;
  readonly #everyMs: number;
  readonly #tickMs: number;
  /** Calls held with keep-alives and no answer yet, by when each call started. */
  readonly #queued = new Set<{ t0: number }>();
  /** An answer has started streaming somewhere in this run: nothing more to say. */
  #warm = false;
  /** When the wait being reported started: the oldest queued call. Kept once announced, across retries. */
  #since: number | null = null;
  #announced = false;
  #lastSaid = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(say: (msg: string) => void, o: { afterMs?: number; everyMs?: number; tickMs?: number } = {}) {
    this.#say = say;
    this.#afterMs = o.afterMs ?? 20_000;
    this.#everyMs = o.everyMs ?? 60_000;
    this.#tickMs = o.tickMs ?? Math.min(1000, this.#afterMs / 4, this.#everyMs / 4);
  }

  begin(): StreamWatch & { end(): void } {
    const call = { t0: performance.now() };
    return {
      waiting: () => {
        if (this.#warm || this.#queued.has(call)) return;
        this.#queued.add(call);
        this.#since = Math.min(this.#since ?? call.t0, call.t0);
        this.#timer ??= setInterval(() => this.#tick(), this.#tickMs);
        this.#timer.unref?.();
      },
      started: () => {
        this.#queued.delete(call);
        if (this.#warm) return;
        this.#warm = true;
        if (this.#announced && this.#since !== null) this.#say(`Hosted pool is up after ${waited(performance.now() - this.#since)}.`);
        this.dispose();
      },
      end: () => {
        this.#queued.delete(call);
        if (this.#queued.size) return;
        this.#stopTimer();
        // A short wait that ended without a word starts over next time; an announced one carries on through a retry.
        if (!this.#announced) this.#since = null;
      },
    };
  }

  /** Stop the timer for good: the run is over. */
  dispose(): void {
    this.#warm = true;
    this.#stopTimer();
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    if (this.#warm || !this.#queued.size || this.#since === null) return;
    const now = performance.now();
    if (!this.#announced) {
      if (now - this.#since < this.#afterMs) return;
      this.#announced = true;
      this.#lastSaid = now;
      this.#say("Hosted pool warming up (a GPU worker is starting; usually 3-4 min)…");
    } else if (now - this.#lastSaid >= this.#everyMs) {
      this.#lastSaid = now;
      this.#say(`Still waiting for a hosted GPU worker: ${waited(now - this.#since)} so far.`);
    }
  }
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
