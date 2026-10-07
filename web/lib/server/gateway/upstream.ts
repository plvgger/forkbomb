// One call to the upstream OpenAI-compatible server (vLLM on RunPod serverless, or anything that speaks
// /chat/completions). Owns the timeout, the client-disconnect link, and one retry for cold starts.
// RunPod's job queue (runpod.ts) reuses all of it and only changes how the request travels.
// Nothing here may put the upstream URL, key or model into a client-facing message.

import { ApiError } from "../http";

export type UpstreamTarget = {
  baseUrl: string;
  apiKey: string;
  /** The upstream model name, scrubbed from messages like the URL and key. */
  model?: string;
};

export type CallOptions = {
  /** Whole-call budget, including reading a streamed body. */
  timeoutMs: number;
  /** The request's whole budget, for the timeout message. Defaults to timeoutMs. */
  budgetMs?: number;
  /** Wait before the single retry on 502/503 or a refused connection (a cold GPU worker). */
  retryDelayMs: number;
  /** Aborts the call when the client goes away. */
  clientSignal?: AbortSignal;
};

/** Why a call was aborted. */
export type AbortReason = "timeout" | "client";

const RETRY_STATUSES = new Set([502, 503]);

export class UpstreamCall {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onClientAbort = () => this.abort("client");
  reason: AbortReason | null = null;

  constructor(
    protected readonly target: UpstreamTarget,
    protected readonly opts: CallOptions,
  ) {
    this.timer = setTimeout(() => this.abort("timeout"), opts.timeoutMs);
    if (opts.clientSignal?.aborted) this.abort("client");
    else opts.clientSignal?.addEventListener("abort", this.onClientAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason: AbortReason): void {
    if (this.controller.signal.aborted) return;
    this.reason = reason;
    this.controller.abort();
  }

  /** Stop the timer and drop the client listener. Call once the body is fully read or abandoned. */
  close(): void {
    clearTimeout(this.timer);
    this.opts.clientSignal?.removeEventListener("abort", this.onClientAbort);
  }

  /**
   * POST body to <baseUrl>/chat/completions. Returns any HTTP response (the caller maps statuses).
   * Throws ApiError 504 on timeout, 503 when unreachable, and AbortedByClient when the client left.
   */
  async post(body: Record<string, unknown>): Promise<Response> {
    return this.postWithRetry(`${this.target.baseUrl}/chat/completions`, body, body.stream ? "text/event-stream" : "application/json", this.signal);
  }

  /** The Authorization header for the upstream, when it has a key. */
  protected auth(): Record<string, string> {
    return this.target.apiKey ? { Authorization: `Bearer ${this.target.apiKey}` } : {};
  }

  /** POSTs JSON with one retry on 502/503 or a refused connection (a cold GPU worker). Throws like post(). */
  protected async postWithRetry(url: string, body: unknown, accept: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt > 0;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: accept, ...this.auth() },
          body: JSON.stringify(body),
          signal,
        });
        if (last || !RETRY_STATUSES.has(res.status)) return res;
        await res.body?.cancel().catch(() => {});
      } catch (err) {
        if (this.signal.aborted) throw this.abortError();
        if (last) {
          console.error("[gateway] upstream unreachable", err instanceof Error ? err.name : "error");
          throw new ApiError(503, "upstream_unavailable", "The hosted GPU pool is unreachable. Try again shortly.", {
            "Retry-After": "10",
          });
        }
      }
      await sleep(this.opts.retryDelayMs, this.signal);
      if (this.signal.aborted) throw this.abortError();
    }
  }

  /** The error for an aborted call. */
  abortError(): ApiError {
    return this.reason === "client"
      ? new AbortedByClient()
      : new ApiError(504, "upstream_timeout", `The hosted model did not finish within ${Math.round((this.opts.budgetMs ?? this.opts.timeoutMs) / 1000)}s.`);
  }
}

/** The client disconnected. Nobody reads the response; it exists so the route can still return something. */
export class AbortedByClient extends ApiError {
  constructor() {
    super(499, "client_closed_request", "Client closed the request.");
  }
}

/** Waits ms, or less if signal aborts first. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Removes anything that identifies the upstream from a message, and bounds its length. */
export function scrub(message: string, target: UpstreamTarget): string {
  let out = message;
  const secrets = [target.apiKey, target.baseUrl, hostOf(target.baseUrl), target.model ?? ""].filter((s) => s.length >= 4);
  for (const s of secrets) out = out.split(s).join("[upstream]");
  return out.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The error message from an upstream error body (OpenAI or vLLM shape), or "". */
export function upstreamErrorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    if (typeof body.error === "string") return body.error;
    if (typeof body.error?.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
    if (typeof body.detail === "string") return body.detail;
  } catch {}
  return "";
}
