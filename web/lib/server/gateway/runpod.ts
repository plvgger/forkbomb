// RunPod serverless's job queue as the upstream transport. RunPod's OpenAI route keeps a job generating after
// the client hangs up, so a killed fork's last turn would run (and bill) to the end; a queued job can be cancelled.
// POST /run queues the request; /stream/{id} returns the OpenAI SSE text produced since the previous poll (in
// batches, and the poll holds ~10s while the job waits for a worker); /status/{id} has the final word.
// The caller gets the Response a plain OpenAI server would give (SSE or JSON), so metering does not change.

import { ApiError } from "../http";
import { sseComment, sseData } from "./sse";
import { sleep, UpstreamCall, upstreamErrorMessage, type CallOptions, type UpstreamTarget } from "./upstream";

export type RunpodTimings = {
  /** How long a stream waits for its first output before sending headers, so a job that fails fast keeps its HTTP status. */
  headStartMs: number;
  /** Silence after which a stream sends an SSE comment, so clients and proxies hold on through a cold start. */
  keepAliveMs: number;
  /**
   * Least time between two polls of a job, output flowing or not. A poll returns everything produced since the last
   * one, so polling faster only spends RunPod's per-endpoint rate limits, which every request shares. Doubles for
   * /status, up to statusPollMaxMs.
   */
  pollMs: number;
  statusPollMaxMs: number;
  /** Ceiling for one /run, /stream or /status request. */
  requestTimeoutMs: number;
  /** How long a cancel keeps trying: POST /cancel is sent again after a 429, a 5xx or a network error. */
  cancelTimeoutMs: number;
};

export const RUNPOD_DEFAULTS: RunpodTimings = {
  headStartMs: 5_000,
  keepAliveMs: 10_000,
  pollMs: 250,
  statusPollMaxMs: 1_000,
  requestTimeoutMs: 30_000,
  cancelTimeoutMs: 5_000,
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
/** Poll answers worth asking again after. Anything else means the job is out of reach. A 429 is not a failure at all. */
const TRANSIENT = new Set([500, 502, 503, 504]);
const MAX_POLL_FAILURES = 3;
/** Longest wait after a 429, Retry-After included. The call's own deadline decides when to give up. */
const MAX_THROTTLE_WAIT_MS = 10_000;
/** How long a job's own limits on RunPod outlast the call, so a job whose cancel is lost still stops soon after. */
const POLICY_MARGIN_MS = 10_000;
const DONE_AT_END = /(?:^|[\r\n])data: ?\[DONE\]\s*$/;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** https://api.runpod.ai/v2/<id>/openai/v1 -> https://api.runpod.ai/v2/<id>. Without the suffix, it already is the job base. */
export const runpodJobBase = (baseUrl: string) => baseUrl.replace(/\/openai\/v1$/i, "");

type Job = Record<string, unknown>;
type Failure = { status: number; message: string };

/** What a stream has to say next. */
type Step = { kind: "data"; text: string } | { kind: "idle" } | { kind: "end" } | ({ kind: "failed" } & Failure);

export class RunpodCall extends UpstreamCall {
  private readonly jobBase: string;
  private readonly t: RunpodTimings;
  /** Stops polls nobody will read (the response was dropped). The call's own signal covers aborts and the timeout. */
  private readonly polls = new AbortController();
  private readonly live: AbortSignal;
  private readonly startedAt = Date.now();
  private jobId: string | null = null;
  /** The job is over, or its output is complete: there is nothing left to cancel. */
  private ended = false;
  private cancelling: Promise<void> | null = null;
  /** When the last /stream or /status request went out, to space polls. */
  private lastPoll = 0;
  private throttleLogged = false;

  // Streaming state: the poll in flight, a partial SSE event waiting for its rest, and how far the output got.
  private pending: Promise<Job> | null = null;
  private held = "";
  private produced = false;
  private outputEnded = false;
  private sawDone = false;
  private finished = false;

  constructor(target: UpstreamTarget, opts: CallOptions, timings: Partial<RunpodTimings> = {}) {
    super(target, opts);
    this.jobBase = runpodJobBase(target.baseUrl);
    this.t = { ...RUNPOD_DEFAULTS, ...timings };
    this.live = AbortSignal.any([this.signal, this.polls.signal]);
    // The client left (streaming) or time ran out: free the GPU now instead of when the job would have ended.
    this.signal.addEventListener("abort", () => void this.cancelJob(), { once: true });
  }

  /** Queues body as a job and answers like an OpenAI server: SSE when streaming, otherwise one JSON completion. */
  async post(body: Record<string, unknown>): Promise<Response> {
    // Nobody reads a job past this call's deadline. Its own limits end it shortly after, even if every cancel is
    // lost (otherwise it could wait a day in the queue, then run unread): ttl counts from submission, time in the
    // queue included, and executionTimeout from when a worker takes it. RunPod's minimums are 10 s and 5 s.
    const left = this.opts.timeoutMs - (Date.now() - this.startedAt) + POLICY_MARGIN_MS;
    const policy = { executionTimeout: Math.max(5_000, left), ttl: Math.max(10_000, left) };
    // /run does not follow the call's signal: a job created while the client was leaving must be known, to cancel it.
    const run = await this.postWithRetry(
      `${this.jobBase}/run`,
      { input: { route: "/v1/chat/completions", method: "POST", body }, policy },
      "application/json",
      AbortSignal.timeout(this.t.requestTimeoutMs),
    );
    if (!run.ok) return run; // mapped like any upstream status: 401 unavailable, 429 busy, ...
    const id = (await readJob(run))?.id;
    if (typeof id !== "string" || !id) {
      console.error("[gateway] RunPod /run answered without a job id");
      return errorReply(500, "");
    }
    this.jobId = id;
    if (this.signal.aborted) {
      void this.cancelJob();
      throw this.abortError();
    }
    return body.stream ? this.streamJob() : this.awaitJob();
  }

  /** Also cancels a job whose response was dropped before the job ended. */
  close(): void {
    super.close();
    this.polls.abort();
    void this.cancelJob();
  }

  /** Cancels the job: at most once per call, and never a job that already ended. Never throws. */
  private cancelJob(): Promise<void> {
    const id = this.jobId;
    if (!id || this.ended) return this.cancelling ?? Promise.resolve();
    this.cancelling ??= this.sendCancel(id);
    return this.cancelling;
  }

  /**
   * POST /cancel/{id}, sent again after a 429 (waiting as told), a 5xx or a network error until cancelTimeoutMs runs
   * out. /cancel has RunPod's tightest limits (100 per 10 s, 20 at once), and many forks die at once at the end of a
   * race. A 404 means the job is already gone. If every try fails, the job's own policy (see post) stops it.
   */
  private async sendCancel(id: string): Promise<void> {
    const deadline = AbortSignal.timeout(this.t.cancelTimeoutMs);
    let why = "";
    for (let attempt = 0; !deadline.aborted; attempt++) {
      let wait: number | null = null;
      try {
        const res = await fetch(`${this.jobBase}/cancel/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { Accept: "application/json", ...this.auth() },
          signal: deadline,
        });
        await res.body?.cancel().catch(() => {});
        if (res.ok || res.status === 404) return;
        why = `answered ${res.status}`;
        if (res.status !== 429 && !TRANSIENT.has(res.status)) break;
        wait = retryAfterMs(res.headers);
      } catch (err) {
        why = `failed (${err instanceof Error ? err.name : "error"})`;
      }
      await sleep(wait ?? backoff(this.t.pollMs, attempt), deadline);
    }
    console.error(`[gateway] RunPod cancel of job ${id} ${why}; its time limit will stop it`);
  }

  /** Non-streaming: poll /status until the job ends. A client leaving does not stop it (usage stays real); the timeout does. */
  private async awaitJob(): Promise<Response> {
    for (let wait = this.t.pollMs; ; wait = Math.min(wait * 2, this.t.statusPollMaxMs)) {
      const job = await this.getJob("status");
      if (TERMINAL.has(String(job.status))) {
        this.ended = true;
        return this.jobResult(job);
      }
      await sleep(wait, this.signal);
      if (this.signal.aborted) throw this.abortError();
    }
  }

  /** A finished non-streaming job as the answer an OpenAI server would have sent. */
  private jobResult(job: Job): Response {
    if (job.status !== "COMPLETED") {
      const f = this.failure(job);
      return errorReply(f.status, f.message);
    }
    const out: unknown = Array.isArray(job.output) ? job.output[0] : job.output;
    if (out && typeof out === "object" && !Array.isArray(out)) {
      const { error, choices } = out as { error?: unknown; choices?: unknown };
      if (error && choices === undefined) {
        return errorReply(httpStatus((error as { code?: unknown } | null)?.code), upstreamErrorMessage(JSON.stringify(out)));
      }
      return new Response(JSON.stringify(out), { status: 200, headers: JSON_HEADERS });
    }
    // Not a completion: the caller answers 502 for an unreadable body.
    return new Response(typeof out === "string" ? out : "", { status: 200, headers: JSON_HEADERS });
  }

  /**
   * Streaming: answers at the first output (or a failure, with its real status, or when the head start runs out),
   * then relays each poll's output as it arrives, with a keep-alive comment through long silences.
   */
  private async streamJob(): Promise<Response> {
    const first = await this.next(Date.now() + this.t.headStartMs);
    if (first.kind === "failed") return errorReply(first.status, first.message);
    let carried: Step | null = first;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const step =
          carried ??
          (await this.next(Date.now() + this.t.keepAliveMs).catch((err: unknown) => {
            void this.cancelJob(); // lost track of a running job (after an abort it is already cancelled)
            throw err;
          }));
        carried = null;
        if (step.kind === "data") return controller.enqueue(encoder.encode(step.text));
        if (step.kind === "idle") return controller.enqueue(encoder.encode(sseComment("keep-alive")));
        // After the headers, a failure becomes the mid-stream error event the caller already reports.
        if (step.kind === "failed") {
          controller.enqueue(encoder.encode(sseData(JSON.stringify({ error: { message: step.message, code: step.status } }))));
        }
        controller.close();
      },
      cancel: () => {
        this.polls.abort();
        return this.cancelJob();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  }

  /** The stream's next step, or "idle" when nothing arrives before `until` (the poll keeps going for the next call). */
  private async next(until: number): Promise<Step> {
    for (;;) {
      if (this.outputEnded || this.sawDone) return this.finish();
      this.pending ??= quiet(this.pollStream());
      const poll = await before(this.pending, until);
      if (!poll) return { kind: "idle" };
      this.pending = null;
      if (TERMINAL.has(String(poll.status))) this.outputEnded = true;
      const items: unknown[] = Array.isArray(poll.stream) ? poll.stream : [];
      const text = this.take(
        items.map((i) => (i as { output?: unknown } | null)?.output),
        this.outputEnded,
      );
      if (text) return { kind: "data", text };
    }
  }

  /** The next /stream poll, sent no sooner than pollMs after the last one: never a busy loop, even while output flows. */
  private async pollStream(): Promise<Job> {
    await sleep(this.lastPoll + this.t.pollMs - Date.now(), this.live);
    return this.getJob("stream");
  }

  /** Complete SSE events from new outputs. A partial event waits for its rest, unless the output is over. */
  private take(outputs: unknown[], flush: boolean): string {
    const all = this.held + outputs.map(asSse).join("");
    const cut = flush ? all.length : eventsEnd(all);
    this.held = all.slice(cut);
    let text = all.slice(0, cut);
    // The output is over: a last event missing its blank line gets one, so an error event sent next stays its own event.
    if (flush && eventsEnd(text) < text.length) text += "\n\n";
    if (text) this.produced = true;
    // [DONE] closes the output: the job finishes on its own and must not be cancelled.
    if (DONE_AT_END.test(text)) {
      this.sawDone = true;
      this.ended = true;
    }
    return text;
  }

  /** The output is over. Without [DONE], /status says why: /stream reports a FAILED job as COMPLETED with nothing. */
  private async finish(): Promise<Step> {
    if (this.finished || this.sawDone) return { kind: "end" };
    this.finished = true;
    this.ended = true;
    let job: Job | null = null;
    try {
      job = await this.getJob("status");
    } catch (err) {
      if (this.signal.aborted) throw err;
    }
    // Without /status the job's fate is unknown: what it produced is never passed off as a whole answer.
    if (!job) return { kind: "failed", status: 500, message: "" };
    const status = String(job.status);
    if (status !== "COMPLETED" && TERMINAL.has(status)) return { kind: "failed", ...this.failure(job) };
    if (!this.produced && Array.isArray(job.output)) {
      const text = this.take(job.output, true);
      if (text) return { kind: "data", text };
    }
    return this.produced ? { kind: "end" } : { kind: "failed", status: 500, message: "" };
  }

  /** Why a job ended without a completion, as the upstream status and message it stands for. */
  private failure(job: Job): Failure {
    const f: Failure = job.status === "FAILED" ? jobError(job.error) : { status: 500, message: "" };
    if (f.status >= 500) console.error(`[gateway] RunPod job ${this.jobId} ended ${String(job.status)}`, String(job.error ?? "").slice(0, 300));
    return f;
  }

  /**
   * GET /<path>/{id}, asking again after a transient failure. Throws on abort, or once the job is out of reach.
   * A 429 is back-pressure, not a lost job: the limits are per endpoint and every request shares them. It waits as
   * told (or backs off) for as long as the call has time, and never counts toward giving up.
   */
  private async getJob(path: "stream" | "status"): Promise<Job> {
    for (let failures = 0, throttled = 0; ; ) {
      let why = "";
      let fatal = false;
      let wait: number | null = null;
      try {
        this.lastPoll = Date.now();
        const res = await fetch(`${this.jobBase}/${path}/${encodeURIComponent(this.jobId!)}`, {
          headers: { Accept: "application/json", ...this.auth() },
          signal: AbortSignal.any([this.live, AbortSignal.timeout(this.t.requestTimeoutMs)]),
        });
        // An answer that raced the abort (often "CANCELLED", after our own cancel) is not news: the abort is.
        if (this.signal.aborted) throw this.abortError();
        if (res.ok) {
          const job = await readJob(res);
          if (job) return job;
          why = "unreadable body";
        } else if (res.status === 429) {
          await res.body?.cancel().catch(() => {});
          if (!this.throttleLogged) console.error(`[gateway] RunPod is rate-limiting polls of job ${this.jobId} (${path}); backing off`);
          this.throttleLogged = true;
          wait = retryAfterMs(res.headers) ?? backoff(this.t.pollMs, throttled++);
        } else {
          await res.body?.cancel().catch(() => {});
          why = `HTTP ${res.status}`;
          fatal = !TRANSIENT.has(res.status);
        }
      } catch (err) {
        if (this.signal.aborted) throw this.abortError();
        if (this.polls.signal.aborted || err instanceof ApiError) throw err;
        why = err instanceof Error ? err.name : "error";
      }
      if (this.signal.aborted) throw this.abortError();
      if (wait === null) {
        if (fatal || ++failures >= MAX_POLL_FAILURES) {
          console.error(`[gateway] lost track of RunPod job ${this.jobId} (${path}: ${why})`);
          throw new ApiError(502, "upstream_error", "The hosted model stopped reporting progress. No credit was charged.");
        }
        wait = failures * 2 * this.t.pollMs;
      }
      await sleep(wait, this.live);
    }
  }
}

/**
 * Status and message of a FAILED job. worker-vllm wraps vLLM's own answer in a Python repr:
 * {'message': 'vLLM returned HTTP 400: {"error":{"message":"..."}}', 'type': 'worker_error', 'code': None}.
 * Anything else is a worker failure: 500, no message.
 */
export function jobError(error: unknown): Failure {
  const nested = (error as { message?: unknown } | null)?.message;
  const text = (typeof error === "string" ? error : typeof nested === "string" ? nested : "").slice(0, 8_192);
  const m = /vLLM returned HTTP (\d{3}):\s*/.exec(text);
  if (!m) return { status: 500, message: "" };
  let rest = text.slice(m.index + m[0].length);
  if (text.startsWith("{'")) rest = rest.replace(/\\([\\'])/g, "$1"); // undo the repr's escapes
  return { status: httpStatus(Number(m[1])), message: leadingMessage(rest) };
}

/** The message of the JSON error body text starts with (the repr runs on after it), or the plain text up to the quote. */
function leadingMessage(text: string): string {
  if (text.startsWith("{")) {
    for (let end = text.lastIndexOf("}"); end > 0; end = text.lastIndexOf("}", end - 1)) {
      const msg = upstreamErrorMessage(text.slice(0, end + 1));
      if (msg) return msg;
    }
  }
  return text.split(/'\s*[,}]/)[0]!.trim();
}

const httpStatus = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 400 && n <= 599 ? n : 500);

/** The nth wait (from 0) of an exponential backoff from base, jittered so requests throttled together come back apart. */
function backoff(base: number, n: number): number {
  const step = Math.min(MAX_THROTTLE_WAIT_MS, base * 2 ** (n + 1));
  return step / 2 + Math.random() * (step / 2);
}

/** Retry-After as a wait in ms, capped. An HTTP date or a missing header gives null. */
function retryAfterMs(h: Headers): number | null {
  const v = h.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(MAX_THROTTLE_WAIT_MS, s * 1000) : null;
}

/** An upstream-style error answer, which the caller maps like any other upstream status. */
const errorReply = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: JSON_HEADERS });

/** A /stream output as SSE text: worker-vllm sends raw SSE strings; anything else is taken as one data event. */
const asSse = (output: unknown) => (typeof output === "string" ? output : output == null ? "" : sseData(JSON.stringify(output)));

/** Where the last complete SSE event in text ends (0 if none has). */
function eventsEnd(text: string): number {
  let end = 0;
  for (const m of text.matchAll(/\r\n\r\n|\n\n|\r\r/g)) end = m.index + m[0].length;
  return end;
}

async function readJob(res: Response): Promise<Job | null> {
  const body: unknown = await res.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Job) : null;
}

/** p's value, or undefined if `until` (ms since epoch) comes first. p keeps going either way. */
function before<T>(p: Promise<T>, until: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now()));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** Marks p as handled: a poll may be dropped unawaited when the stream ends while it is in flight. */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}
