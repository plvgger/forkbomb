// POST /api/v1/chat/completions: the metered gateway in front of the hosted model.
// authenticate -> rate limit -> reserve the most this request can cost -> upstream -> settle the real cost.
// Every path that reserved also settles exactly once (a failed upstream settles at zero, a full refund);
// if a settle itself fails, the price cron's expireStaleReservations() refunds the hold in full.

import { BRAND, getConfig, type Config } from "../config";
import {
  costMicroUsd,
  formatMicroUsd,
  InsufficientCreditsError,
  reserve,
  settle,
  type Reservation,
  type Settlement,
} from "../credits";
import { ApiError, json, readJsonObject } from "../http";
import { authenticate } from "../keys";
import { enforce } from "../ratelimit";
import { BYTES_PER_TOKEN, generatedBytes, MAX_BODY_BYTES, parseChatRequest, readUsage, type ChatRequest, type Usage } from "./request";
import { RunpodCall, type RunpodTimings } from "./runpod";
import { sseComment, sseData, SseSplitter, type SseEvent } from "./sse";
import { scrub, UpstreamCall, upstreamErrorMessage, type CallOptions, type UpstreamTarget } from "./upstream";

export const HEADER_REMAINING = "x-credits-remaining-usd";
export const HEADER_COST = "x-request-cost-usd";
export const HEADER_RESERVED = "x-credits-reserved-usd";

/** The model name clients see. The upstream model name, URL and key never leave the server. */
export const hostedModel = () => `${BRAND.slug}-hosted`;

/** The hosted model as an OpenAI model object, for GET /api/v1/models. `created` is when the pool went live. */
export const hostedModelObject = () => ({
  id: hostedModel(),
  object: "model" as const,
  created: Math.floor(Date.UTC(2026, 9, 1) / 1000),
  owned_by: BRAND.slug,
});

/**
 * The chat route's maxDuration in seconds. Next.js needs a literal in the route file, so route.ts repeats
 * this number and a test checks the two match.
 */
export const ROUTE_MAX_DURATION_S = 300;
/** Time kept back from maxDuration so a timed-out call can still settle and answer before the platform kills it. */
export const SETTLE_MARGIN_S = 20;

export type GatewayOptions = {
  /** Whole-request budget, measured from startedAt (not from when upstream is called). */
  timeoutMs?: number;
  retryDelayMs?: number;
  /** When the request started (ms since epoch). Defaults to when chatCompletions was called. */
  startedAt?: number;
  /** RunPod queue polling and keep-alive timings (tests shorten them). */
  runpod?: Partial<RunpodTimings>;
  /**
   * Keeps the platform running until background work ends: the settle and any job cancel after a client leaves
   * a stream. The route passes Next's after(); without it, a frozen function could drop a cancel.
   */
  waitUntil?: (work: Promise<unknown>) => void;
};
export const GATEWAY_DEFAULTS = { timeoutMs: (ROUTE_MAX_DURATION_S - SETTLE_MARGIN_S) * 1000, retryDelayMs: 2_000 };

const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };

export async function chatCompletions(req: Request, options: GatewayOptions = {}): Promise<Response> {
  const startedAt = options.startedAt ?? Date.now();
  const opts = { ...GATEWAY_DEFAULTS, ...options };
  const workspace = await authenticate(req);
  const cfg = getConfig();
  if (!cfg.upstream.baseUrl) {
    throw new ApiError(
      503,
      "upstream_unavailable",
      "The hosted GPU pool is not provisioned yet. No credit was charged; self-hosted engines are unaffected.",
    );
  }
  await enforce("gateway", workspace.id);
  const chat = parseChatRequest(await readJsonObject(req, MAX_BODY_BYTES));

  const maxCost = Math.max(1, costMicroUsd(chat.estimatedInputTokens, chat.maxTokens, cfg.pricing));
  let rsv: Reservation;
  try {
    rsv = await reserve(workspace.id, maxCost);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      throw withHeaders(err, { [HEADER_REMAINING]: formatMicroUsd(err.balanceMicroUsd) });
    }
    throw err;
  }

  const meter = new Meter(rsv, cfg, chat.billedInputTokens);
  const target: UpstreamTarget = { baseUrl: cfg.upstream.baseUrl, apiKey: cfg.upstream.apiKey, model: cfg.upstream.model };
  // Non-streaming calls run to completion even if the client leaves, so usage is always real.
  // Streaming calls stop the GPU as soon as the client leaves and bill what was streamed
  // (on RunPod's queue by cancelling the job: its OpenAI route would keep generating).
  // Auth, rate limit, body and reserve already used part of the budget: upstream gets only what is left.
  const callOpts: CallOptions = {
    timeoutMs: Math.max(1, opts.timeoutMs - (Date.now() - startedAt)),
    budgetMs: opts.timeoutMs,
    retryDelayMs: opts.retryDelayMs,
    clientSignal: chat.stream ? req.signal : undefined,
  };
  const call = cfg.upstream.transport === "runpod" ? new RunpodCall(target, callOpts, opts.runpod) : new UpstreamCall(target, callOpts);
  keepAlive(opts.waitUntil, meter.whenSettled.then(() => call.backgroundWork()));
  const upstreamBody = {
    ...cfg.upstream.extraBody,
    ...chat.body,
    model: cfg.upstream.model,
    stream: chat.stream,
    ...(chat.stream ? { stream_options: { include_usage: true } } : {}),
  };

  let handedOff = false;
  try {
    const res = await call.post(upstreamBody);
    if (!res.ok) throw await upstreamFailure(res, target);
    if (chat.stream && !isEventStream(res)) throw await notAStream(res, target);
    if (chat.stream) {
      const out = streamResponse(res, chat, meter, call, target);
      handedOff = true;
      return out;
    }
    return await completeResponse(res, meter, call);
  } catch (err) {
    const s = await meter.settle(ZERO, "error");
    if (err instanceof ApiError) throw withHeaders(err, creditHeaders(s));
    throw err;
  } finally {
    if (!handedOff) {
      call.close();
      await meter.settle(ZERO, "error"); // no-op unless something above skipped settling
    }
  }
}

/** Hands background work to the platform. Never fails the request: outside a request scope after() throws. */
function keepAlive(waitUntil: GatewayOptions["waitUntil"], work: Promise<unknown>): void {
  const quiet = work.catch(() => {});
  try {
    waitUntil?.(quiet);
  } catch (err) {
    console.warn("[gateway] could not register background work", err instanceof Error ? err.message : err);
  }
}

/** Settles one reservation exactly once, whichever path gets there first. */
class Meter {
  private settled: Promise<Settlement | null> | null = null;
  private markSettled!: () => void;
  /** Resolves once the reservation is settled (or the settle failed and was logged). */
  readonly whenSettled = new Promise<void>((resolve) => (this.markSettled = resolve));

  constructor(
    readonly rsv: Reservation,
    private readonly cfg: Config,
    /** The calibrated input estimate (not the reservation's upper bound). */
    private readonly billedInputTokens: number,
  ) {}

  get done(): boolean {
    return this.settled !== null;
  }

  settle(usage: Usage, status: "ok" | "error"): Promise<Settlement | null> {
    this.settled ??= settle(this.rsv.id, costMicroUsd(usage.inputTokens, usage.outputTokens, this.cfg.pricing), {
      model: this.cfg.upstream.model,
      ...usage,
      status,
    })
      .catch((err: unknown) => {
        console.error("[gateway] settle failed; the reservation will expire with a full refund", err);
        return null;
      })
      .finally(() => this.markSettled());
    return this.settled;
  }

  /** Usage when upstream never reported it: the calibrated input estimate plus what was generated, at least a token per chunk. */
  estimate(outputBytes: number, outputChunks: number): Usage {
    return {
      inputTokens: this.billedInputTokens,
      outputTokens: Math.max(outputChunks, Math.ceil(outputBytes / BYTES_PER_TOKEN)),
    };
  }
}

function creditHeaders(s: Settlement | null): Record<string, string> {
  if (!s) return {};
  return { [HEADER_COST]: formatMicroUsd(s.chargedMicroUsd), [HEADER_REMAINING]: formatMicroUsd(s.balanceMicroUsd) };
}

const withHeaders = (err: ApiError, headers: Record<string, string>) =>
  new ApiError(err.status, err.code, err.message, { ...err.headers, ...headers });

/**
 * Only OpenAI's own fields go back to the client. vLLM adds its own (prompt_token_ids, prompt_text, token_ids,
 * stop_reason, routed_experts, kv_transfer_params, system_fingerprint, ...), which name the inference server and
 * show the model's architecture. Reasoning text stays (it is billed as output), as reasoning_content or reasoning.
 */
const TOP_FIELDS = ["id", "object", "created", "model", "choices", "usage"];
const CHOICE_FIELDS = ["index", "message", "delta", "finish_reason", "logprobs"];
const MESSAGE_FIELDS = ["role", "content", "tool_calls", "refusal", "reasoning_content", "reasoning"];
const TOOL_CALL_FIELDS = ["index", "id", "type", "function"];
const FUNCTION_FIELDS = ["name", "arguments"];
const USAGE_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"];
/** Dropped when null: OpenAI never sends them as null, vLLM does. */
const DROP_NULL = new Set(["reasoning_content", "reasoning", "refusal"]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj && !(obj[k] === null && DROP_NULL.has(k))) out[k] = obj[k];
  return out;
}

function pickMessage(m: unknown): unknown {
  if (!isObject(m)) return m;
  const out = pick(m, MESSAGE_FIELDS);
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((tc: unknown) => {
      if (!isObject(tc)) return tc;
      const call = pick(tc, TOOL_CALL_FIELDS);
      if (isObject(call.function)) call.function = pick(call.function, FUNCTION_FIELDS);
      return call;
    });
  }
  return out;
}

/** An answer or stream chunk with only OpenAI's fields, the model renamed. */
export function openaiShape(body: Record<string, unknown>): Record<string, unknown> {
  const out = pick(body, TOP_FIELDS);
  if ("model" in out) out.model = hostedModel();
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((c: unknown) => {
      if (!isObject(c)) return c;
      const choice = pick(c, CHOICE_FIELDS);
      if ("message" in choice) choice.message = pickMessage(choice.message);
      if ("delta" in choice) choice.delta = pickMessage(choice.delta);
      return choice;
    });
  }
  if (isObject(out.usage)) out.usage = pick(out.usage, USAGE_FIELDS);
  return out;
}

/**
 * Upstream rejections that quote the model's chat template (and so name its family), reworded as what to fix.
 * Anything else passes through scrubbed.
 */
const TEMPLATE_ERRORS: [RegExp, string][] = [[/no user query found in messages/i, "messages must include at least one user message."]];
const rejectionDetail = (detail: string) => TEMPLATE_ERRORS.find(([re]) => re.test(detail))?.[1] ?? detail;

/** Maps an upstream error status to what the client sees. The client is never charged for these. */
async function upstreamFailure(res: Response, target: UpstreamTarget): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const detail = scrub(upstreamErrorMessage(text), target);
  const s = res.status;
  if (s === 400 || s === 413 || s === 422) {
    return new ApiError(400, "upstream_rejected", `The hosted model rejected the request${detail ? `: ${rejectionDetail(detail)}` : "."}`);
  }
  if (s === 429) {
    return new ApiError(503, "upstream_busy", "The hosted GPU pool is at capacity. Retry shortly.", {
      "Retry-After": /^\d{1,4}$/.test(res.headers.get("retry-after") ?? "") ? res.headers.get("retry-after")! : "5",
    });
  }
  if (s === 401 || s === 403 || s === 404) {
    console.error(`[gateway] upstream answered ${s}: check UPSTREAM_BASE_URL, UPSTREAM_API_KEY and UPSTREAM_MODEL`);
    return new ApiError(503, "upstream_unavailable", "The hosted GPU pool is unavailable right now. No credit was charged.");
  }
  if (s === 502 || s === 503 || s === 504) {
    // Still failing after the cold-start retry.
    return new ApiError(503, "upstream_unavailable", "The hosted GPU pool is warming up. Retry shortly. No credit was charged.", {
      "Retry-After": "10",
    });
  }
  return new ApiError(502, "upstream_error", `The hosted model failed (HTTP ${s}). No credit was charged.`);
}

const isEventStream = (res: Response) => /^text\/event-stream\b/i.test(res.headers.get("content-type") ?? "");

/** A 200 to a streaming request that is not SSE (often an error body): an upstream failure, never forwarded raw. */
async function notAStream(res: Response, target: UpstreamTarget): Promise<ApiError> {
  const detail = scrub(upstreamErrorMessage(await res.text().catch(() => "")), target);
  return new ApiError(502, "upstream_error", `The hosted model did not stream${detail ? `: ${detail}` : "."} No credit was charged.`);
}

async function completeResponse(res: Response, meter: Meter, call: UpstreamCall): Promise<Response> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (call.signal.aborted) throw call.abortError();
    throw new ApiError(502, "upstream_error", "The hosted model response was cut off. No credit was charged.");
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(502, "upstream_error", "The hosted model sent an unreadable response. No credit was charged.");
  }
  let usage = readUsage(body.usage);
  if (!usage) {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const bytes = choices.reduce<number>((n, c) => n + generatedBytes((c as { message?: unknown } | null)?.message), 0);
    usage = meter.estimate(bytes, 0);
  }
  const s = await meter.settle(usage, "ok");
  return json(openaiShape(body), { headers: { ...creditHeaders(s), "x-request-id": meter.rsv.id } });
}

/**
 * Pipes upstream SSE events to the client as they arrive, rewriting "model", capturing the final usage chunk
 * (requested upstream with include_usage) and settling when the stream ends, breaks, or the client leaves.
 * The settled cost is sent as an SSE comment just before [DONE], since headers are already gone by then.
 */
function streamResponse(res: Response, chat: ChatRequest, meter: Meter, call: UpstreamCall, target: UpstreamTarget): Response {
  const reader = (res.body ?? new Response("").body!).getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const splitter = new SseSplitter();
  let usage: Usage | null = null;
  let outputBytes = 0;
  let outputChunks = 0;
  let sawDone = false;
  let upstreamErrored = false;
  let closed = false;

  const used = () => usage ?? meter.estimate(outputBytes, outputChunks);
  const produced = () => usage !== null || outputChunks > 0;

  const clientGone = () => {
    closed = true;
    const settled = meter.settle(used(), "error");
    call.abort("client");
    reader.cancel().catch(() => {});
    call.close();
    return settled;
  };
  call.signal.addEventListener("abort", () => {
    if (closed) return;
    if (call.reason === "client") void clientGone();
    // A timeout settles now even if nobody is pulling; the next pull reports it in-stream.
    else void meter.settle(produced() ? used() : ZERO, "error");
  });

  const transform = (ev: SseEvent): string | null => {
    if (ev.data === null) return sseComment("keep-alive"); // upstream comments may carry anything: never forward them
    if (ev.data.trim() === "[DONE]") {
      sawDone = true;
      return null;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(ev.data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return sseData(scrub(ev.data, target));
      obj = parsed as Record<string, unknown>;
    } catch {
      return sseData(scrub(ev.data, target));
    }
    if (obj.error) {
      upstreamErrored = true;
      const msg = scrub(upstreamErrorMessage(ev.data), target) || "The hosted model failed mid-stream.";
      return sseData(JSON.stringify(new ApiError(502, "upstream_error", msg).toJSON()));
    }
    const u = readUsage(obj.usage);
    if (u) usage = u;
    if (Array.isArray(obj.choices)) {
      for (const c of obj.choices) {
        const bytes = generatedBytes((c as { delta?: unknown } | null)?.delta);
        if (bytes > 0) {
          outputBytes += bytes;
          outputChunks++;
        }
      }
    }
    obj = openaiShape(obj);
    if (!chat.includeUsage && "usage" in obj) {
      // The client did not ask for the usage chunk: some clients break on a chunk with no choices.
      if (Array.isArray(obj.choices) && obj.choices.length === 0) return null;
      delete obj.usage;
    }
    return sseData(JSON.stringify(obj));
  };

  const costComment = (s: Settlement | null) =>
    s ? sseComment(`${HEADER_COST}=${formatMicroUsd(s.chargedMicroUsd)} ${HEADER_REMAINING}=${formatMicroUsd(s.balanceMicroUsd)}`) : "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        // Keep reading until something is enqueued: a pull that enqueues nothing is not called again.
        let done = false;
        let sent = false;
        while (!sent && !done && !sawDone) {
          const read = await reader.read();
          done = read.done;
          const events = done ? [...splitter.push(decoder.decode()), ...splitter.flush()] : splitter.push(decoder.decode(read.value, { stream: true }));
          for (const ev of events) {
            const out = transform(ev);
            if (out) {
              controller.enqueue(encoder.encode(out));
              sent = true;
            }
            if (sawDone) break;
          }
        }
        if (!done && !sawDone) return;
        closed = true;
        if (!done) reader.cancel().catch(() => {});
        call.close();
        // A stream that ended without any output or usage produced nothing to bill.
        const s = await meter.settle(produced() ? used() : ZERO, upstreamErrored || !produced() ? "error" : "ok");
        controller.enqueue(encoder.encode(costComment(s) + sseData("[DONE]")));
        controller.close();
      } catch {
        if (closed) return;
        if (call.reason === "client") {
          await clientGone();
          return;
        }
        closed = true;
        call.close();
        const s = await meter.settle(produced() ? used() : ZERO, "error");
        const err = call.reason === "timeout" ? call.abortError() : new ApiError(502, "upstream_error", "The hosted model stream broke off.");
        try {
          controller.enqueue(encoder.encode(sseData(JSON.stringify(err.toJSON())) + costComment(s)));
          controller.close();
        } catch {}
      }
    },
    async cancel() {
      if (!closed) await clientGone();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // Spendable balance with this request's hold taken out; the settled figures arrive in-stream.
      [HEADER_REMAINING]: formatMicroUsd(meter.rsv.balanceMicroUsd),
      [HEADER_RESERVED]: formatMicroUsd(meter.rsv.amountMicroUsd),
      "x-request-id": meter.rsv.id,
    },
  });
}
