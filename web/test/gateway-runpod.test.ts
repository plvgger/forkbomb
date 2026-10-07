// The metered gateway over RunPod's job queue: a fake /run, /stream, /status and /cancel (fetch stub, no network)
// and a fresh PGlite per test. What matters most: a job the client walked away from is cancelled, exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { costMicroUsd, credit, getBalance } from "../lib/server/credits";
import { int, type Db } from "../lib/server/db";
import { chatCompletions, GATEWAY_DEFAULTS, type GatewayOptions } from "../lib/server/gateway/chat";
import { parseChatRequest } from "../lib/server/gateway/request";
import type { RunpodTimings } from "../lib/server/gateway/runpod";
import { handler } from "../lib/server/http";
import { freshDb, newWorkspace } from "./helpers";

const JOB_BASE = "https://api.runpod.ai/v2/ep0test0queue";
const OPENAI_URL = `${JOB_BASE}/openai/v1`;
const UPSTREAM_KEY = "rp-upstream-secret-key";
const UPSTREAM_MODEL = "upstream-model-test";
const SITE = "https://site.test/api/v1/chat/completions";

let db: Db;
let ws: { id: string; apiKey: string };

const FAST: RunpodTimings = { headStartMs: 300, keepAliveMs: 40, pollMs: 2, statusPollMaxMs: 10, requestTimeoutMs: 2_000, cancelTimeoutMs: 1_000 };

/** The gateway with fast retries and polls, wrapped like the route. */
const gateway = (opts: GatewayOptions = {}) =>
  handler((req: Request) => chatCompletions(req, { retryDelayMs: 1, ...opts, runpod: { ...FAST, ...opts.runpod } }));
const send = gateway();

const chatReq = (body: unknown, opts: { signal?: AbortSignal } = {}) =>
  new Request(SITE, {
    method: "POST",
    headers: { authorization: `Bearer ${ws.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

const hello = { model: "hosted", messages: [{ role: "user", content: "Write a haiku about forks." }] };
const reservationFor = (body: Record<string, unknown>) => {
  const r = parseChatRequest(body);
  return costMicroUsd(r.estimatedInputTokens, r.maxTokens);
};

async function fund(micro: number) {
  await db.tx((q) => credit(q, ws.id, micro, "grant", `test-${Math.random()}`));
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: UPSTREAM_MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const usageChunk = (p: number, c: number) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: UPSTREAM_MODEL, choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })}\n\n`;
const stop = chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const DONE = "data: [DONE]\n\n";

const completion = (content: string, usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: UPSTREAM_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});

/** A FAILED job's error exactly as worker-vllm reports it: vLLM's status and body inside a Python repr. */
const vllmFailure = (status: number, message: string) =>
  `{'message': 'vLLM returned HTTP ${status}: ${JSON.stringify({ error: { message, type: "BadRequestError", param: "max_tokens", code: status } })}', 'type': 'worker_error', 'code': None}`;
const TOO_MANY_TOKENS = `max_tokens=999999 cannot be greater than max_model_len=32768 for ${UPSTREAM_MODEL} at ${OPENAI_URL}. Please request fewer output tokens.`;

type JobScript = {
  /** The job waits this long for a worker (IN_QUEUE). */
  queuedMs?: number;
  /** One entry per /stream poll: output strings, or a poll that holds this long and brings nothing. */
  batches?: (string[] | { silentMs: number })[];
  /** After the batches, keep running with nothing new until cancelled. */
  hang?: boolean;
  /** Ends FAILED with this error. /stream still says COMPLETED with nothing, like RunPod. */
  error?: string;
  /** The non-streaming result (output[0] of /status). */
  completion?: unknown;
  /** Every /stream poll answers this HTTP status. */
  streamStatus?: number;
};

type Call = { method: string; path: string; body: unknown; headers: Headers; signal: AbortSignal; at: number };
type Job = { id: string; stream: boolean; script: JobScript; created: number; next: number; cancelled: boolean };

/** Holds like RunPod's long poll; rejects like fetch when the request is aborted. */
function hold(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(t);
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    if (signal.aborted) return abort();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Stubs fetch with a fake RunPod queue endpoint (worker-vllm). `run` may answer a /run call itself (the nth), and
 * `answer` the nth /stream, /status or /cancel call (the job is untouched then, like a request RunPod turned away).
 * `longPollMs` is how long a /stream poll holds when there is nothing to say. Anything else fails the test.
 */
function runpod(
  script: JobScript,
  opts: { run?: (n: number) => Response | undefined; answer?: (kind: string, n: number) => Response | undefined; longPollMs?: number } = {},
) {
  const calls: Call[] = [];
  const jobs: Job[] = [];
  const longPoll = opts.longPollMs ?? 5;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${JOB_BASE}/`)) throw new Error(`unexpected fetch in test: ${url}`);
      if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      const path = url.slice(JOB_BASE.length);
      const call = {
        method: init?.method ?? "GET",
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        signal: init!.signal!,
        at: Date.now(),
      };
      calls.push(call);
      const [, kind, id] = path.split("/");
      if (path === "/openai/v1/chat/completions") return jsonRes(completion("direct"));
      if (path === "/run") {
        const n = calls.filter((c) => c.path === "/run").length;
        const answer = opts.run?.(n);
        if (answer) return answer;
        const body = (call.body as { input: { body: { stream?: boolean } } }).input.body;
        const job = { id: `job-${n}-u1`, stream: body.stream === true, script, created: Date.now(), next: 0, cancelled: false };
        jobs.push(job);
        return jsonRes({ id: job.id, status: "IN_QUEUE" });
      }
      const answer = opts.answer?.(kind!, calls.filter((c) => c.path.startsWith(`/${kind}/`)).length);
      if (answer) return answer;
      const job = jobs.find((j) => j.id === decodeURIComponent(id ?? ""));
      if (!job) return jsonRes({ status: 404, title: "Not Found", detail: "job not found" }, 404);
      const queuedFor = (job.script.queuedMs ?? 0) - (Date.now() - job.created);
      const batches = job.script.batches ?? [];
      if (kind === "cancel") {
        job.cancelled = true;
        return jsonRes({ id: job.id, status: "CANCELLED" });
      }
      if (kind === "stream") {
        if (job.script.streamStatus) return jsonRes({ error: "worker hiccup" }, job.script.streamStatus);
        if (job.cancelled) return jsonRes({ status: "CANCELLED", stream: [] });
        if (queuedFor > 0) {
          await hold(Math.min(longPoll, queuedFor), call.signal);
          return jsonRes({ status: "IN_QUEUE" });
        }
        const batch = batches[job.next];
        if (batch) {
          job.next++;
          if (Array.isArray(batch)) return jsonRes({ status: "IN_PROGRESS", stream: batch.map((output) => ({ output })) });
          await hold(batch.silentMs, call.signal);
          return jsonRes({ status: "IN_PROGRESS", stream: [] });
        }
        if (job.script.hang) {
          await hold(longPoll, call.signal);
          return jsonRes({ status: job.cancelled ? "CANCELLED" : "IN_PROGRESS", stream: [] });
        }
        return jsonRes({ status: "COMPLETED", stream: [] });
      }
      if (kind === "status") {
        if (job.cancelled) return jsonRes({ id: job.id, status: "CANCELLED" });
        if (queuedFor > 0 || job.script.hang) return jsonRes({ id: job.id, status: queuedFor > 0 ? "IN_QUEUE" : "IN_PROGRESS" });
        if (job.script.error) return jsonRes({ id: job.id, status: "FAILED", error: job.script.error });
        const output = job.stream ? batches.filter((b) => Array.isArray(b)).map((b) => b.join("")) : [job.script.completion];
        return jsonRes({ id: job.id, status: "COMPLETED", output, delayTime: 1, executionTime: 1 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
  const count = (kind: string) => calls.filter((c) => c.path.startsWith(`/${kind}`)).length;
  return { calls, jobs, count };
}

async function reservations() {
  return db.query<{ status: string }>("SELECT status FROM reservations");
}
async function usageRows() {
  const rows = await db.query<{ cost_micro_usd: unknown; status: string; input_tokens: number; output_tokens: number }>(
    "SELECT cost_micro_usd, status, input_tokens, output_tokens FROM usage ORDER BY id",
  );
  return rows.map((r) => ({ ...r, cost_micro_usd: int(r.cost_micro_usd) }));
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const events = (text: string) => text.split("\n\n").filter(Boolean);
const dataOf = (text: string) =>
  events(text)
    .filter((e) => e.startsWith("data: ") && e !== "data: [DONE]")
    .map((e) => JSON.parse(e.slice(6)) as { model: string; choices: { delta: Record<string, unknown> }[]; usage?: unknown; error?: { code: string; message: string } });
const contentOf = (text: string) => dataOf(text).map((d) => (d.choices?.[0]?.delta.content as string | undefined) ?? "").join("");

const expectNoLeak = (text: string) => {
  expect(text).not.toContain(UPSTREAM_MODEL);
  expect(text).not.toContain(UPSTREAM_KEY);
  expect(text).not.toContain("runpod");
};

beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("UPSTREAM_BASE_URL", OPENAI_URL);
  vi.stubEnv("UPSTREAM_API_KEY", UPSTREAM_KEY);
  vi.stubEnv("UPSTREAM_MODEL", UPSTREAM_MODEL);
  vi.stubEnv("UPSTREAM_TRANSPORT", "");
  ws = await newWorkspace();
  await fund(1_000_000);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.close();
});

describe("streaming over the RunPod queue", () => {
  it("queues the request, relays tool call deltas and the usage chunk, debits exactly the usage, and never cancels", async () => {
    const tc = (args: string, first = false) =>
      chunk({ tool_calls: [{ index: 0, ...(first ? { id: "call_9", type: "function", function: { name: "edit_file", arguments: args } } : { function: { arguments: args } }) }] });
    const fake = runpod({
      batches: [[chunk({ role: "assistant", content: "" }) + tc("", true)], [tc('{"path":')], [tc('"a.ts"}'), stop], [usageChunk(50, 9) + DONE]],
    });
    const tools = [{ type: "function", function: { name: "edit_file", parameters: {} } }];
    const body = { ...hello, stream: true, stream_options: { include_usage: true }, tools };
    const res = await send(chatReq(body));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    const run = fake.calls.find((c) => c.path === "/run")!;
    expect(run.method).toBe("POST");
    expect(run.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(run.body).toEqual({
      input: {
        route: "/v1/chat/completions",
        method: "POST",
        body: { messages: hello.messages, tools, max_tokens: parseChatRequest(body).maxTokens, model: UPSTREAM_MODEL, stream: true, stream_options: { include_usage: true } },
      },
      policy: { executionTimeout: expect.any(Number), ttl: expect.any(Number) },
    });
    // The job's own limits end it 10 s after the call's 280 s budget, even if no cancel ever reaches RunPod.
    const { policy } = run.body as { policy: { executionTimeout: number; ttl: number } };
    expect(policy.ttl).toBe(policy.executionTimeout);
    expect(policy.ttl).toBeGreaterThan(GATEWAY_DEFAULTS.timeoutMs + 9_000);
    expect(policy.ttl).toBeLessThanOrEqual(GATEWAY_DEFAULTS.timeoutMs + 10_000);
    expect(fake.calls.filter((c) => c.path.startsWith("/stream/")).every((c) => c.headers.get("authorization") === `Bearer ${UPSTREAM_KEY}`)).toBe(true);

    const data = dataOf(text);
    const deltas = data.filter((d) => d.choices.length).map((d) => d.choices[0]!.delta as { tool_calls?: { id?: string; function: { name?: string; arguments: string } }[] });
    expect(deltas.find((d) => d.tool_calls)!.tool_calls![0]).toMatchObject({ id: "call_9", function: { name: "edit_file" } });
    expect(deltas.flatMap((d) => d.tool_calls ?? []).map((t) => t.function.arguments).join("")).toBe('{"path":"a.ts"}');
    expect(data.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } });
    expect(data.every((d) => d.model === "forkbomb-hosted")).toBe(true);
    expectNoLeak(text);

    const cost = costMicroUsd(50, 9);
    expect(events(text).slice(-2)).toEqual([
      `: x-request-cost-usd=${(cost / 1e6).toFixed(6)} x-credits-remaining-usd=${((1_000_000 - cost) / 1e6).toFixed(6)}`,
      "data: [DONE]",
    ]);
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    expect(await getBalance(ws.id)).toBe(1_000_000 - cost);
    expect((await usageRows()).map((r) => [r.status, r.input_tokens, r.output_tokens])).toEqual([["ok", 50, 9]]);
    expect(fake.count("cancel")).toBe(0); // [DONE] means the job is finishing on its own
    expect(fake.count("status")).toBe(0);
  });

  it("reassembles events split anywhere across polls, and never puts a keep-alive inside one", async () => {
    const full = [chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo wor" }), chunk({ content: "ld" }), stop, usageChunk(30, 4), DONE].join("");
    const pieces = full.match(/[\s\S]{1,7}/g)!;
    const batches: (string[] | { silentMs: number })[] = [];
    for (let i = 0; i < pieces.length; i += 3) batches.push(pieces.slice(i, i + 3));
    // A long silence after the first event went out, while the second is half received.
    let sofar = "";
    const at = batches.findIndex((b) => (sofar += (b as string[]).join("")).includes("\n\n") && !sofar.endsWith("\n\n")) + 1;
    expect(at).toBeGreaterThan(0);
    batches.splice(at, 0, { silentMs: 150 });
    runpod({ batches });

    const res = await send(chatReq({ ...hello, stream: true }));
    const text = await res.text();
    expect(events(text).filter((e) => e === ": keep-alive").length).toBeGreaterThanOrEqual(2);
    expect(events(text).every((e) => e.startsWith(": ") || e.startsWith("data: "))).toBe(true);
    expect(contentOf(text)).toBe("Hello world"); // every data event parsed as JSON
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(30, 4));
  });

  it("keeps the connection alive while the job waits for a worker, then streams", async () => {
    const fake = runpod({ queuedMs: 300, batches: [[chunk({ content: "Hel" }), chunk({ content: "lo" })], [stop + usageChunk(20, 2) + DONE]] });
    const started = Date.now();
    const res = await gateway({ runpod: { headStartMs: 20, keepAliveMs: 60 } })(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(250); // headers went out while the job was still queued
    const text = await res.text();
    const firstData = events(text).findIndex((e) => e.startsWith("data: "));
    expect(firstData).toBeGreaterThanOrEqual(3);
    expect(events(text).slice(0, firstData).every((e) => e === ": keep-alive")).toBe(true);
    expect(contentOf(text)).toBe("Hello");
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(20, 2));
    expect(fake.count("cancel")).toBe(0);
    // Polls back off while queued instead of spinning.
    expect(fake.count("stream")).toBeLessThan(300 / 5 + 10);
  });

  it("cancels the job exactly once, at once, when the client aborts mid-stream, and bills what was streamed", async () => {
    // A long poll is in flight when the client leaves: the cancel must not wait for it.
    const fake = runpod({ batches: [[chunk({ content: "abc" })], [chunk({ content: "def" })]], hang: true }, { longPollMs: 10_000 });
    const body = { ...hello, stream: true };
    const res = await send(chatReq(body));
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("abc");
    await until(() => fake.count("stream") >= 3); // the hanging poll is open
    const left = Date.now();
    await reader.cancel();

    await until(() => fake.count("cancel") === 1);
    expect(Date.now() - left).toBeLessThan(1_000);
    const cancel = fake.calls.find((c) => c.path.startsWith("/cancel/"))!;
    expect(cancel).toMatchObject({ method: "POST", path: `/cancel/${fake.jobs[0]!.id}` });
    expect(cancel.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(fake.calls.filter((c) => c.path.startsWith("/stream/")).at(-1)!.signal.aborted).toBe(true);

    await until(async () => (await reservations())[0]!.status !== "active");
    const est = parseChatRequest(body).estimatedInputTokens;
    const [row] = await usageRows();
    expect(row).toMatchObject({ status: "error", input_tokens: est });
    expect(row!.output_tokens).toBeGreaterThanOrEqual(1);
    expect(row!.cost_micro_usd).toBeLessThanOrEqual(reservationFor(body));
    expect(await getBalance(ws.id)).toBe(1_000_000 - row!.cost_micro_usd);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(1);
  });

  it("cancels once when the request signal aborts while nobody is reading", async () => {
    const fake = runpod({ batches: [[chunk({ content: "abc" })]], hang: true }, { longPollMs: 10_000 });
    const ctl = new AbortController();
    const res = await send(chatReq({ ...hello, stream: true }, { signal: ctl.signal }));
    expect(res.status).toBe(200);
    ctl.abort();
    await until(() => fake.count("cancel") === 1);
    await until(async () => (await reservations())[0]!.status !== "active");
    expect((await usageRows())[0]!.status).toBe("error");
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(1);
  });

  it("times out a job stuck in the queue: reports it in-stream, cancels the job and refunds in full", async () => {
    const fake = runpod({ queuedMs: 60_000 });
    const res = await gateway({ timeoutMs: 200, runpod: { headStartMs: 20, keepAliveMs: 40 } })(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(": keep-alive");
    expect(text).toContain('"code":"upstream_timeout"');
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
    expect(await getBalance(ws.id)).toBe(1_000_000);
    await until(() => fake.count("cancel") === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(1);
  });

  it("a job that fails fast keeps its HTTP status: 400 upstream_rejected, scrubbed, no charge, nothing to cancel", async () => {
    const fake = runpod({ error: vllmFailure(400, TOO_MANY_TOKENS) });
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_rejected", type: "invalid_request_error" } });
    expect(text).toContain("cannot be greater than max_model_len=32768");
    expectNoLeak(text);
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await usageRows()).map((r) => [r.status, r.cost_micro_usd])).toEqual([["error", 0]]);
    expect(fake.count("status")).toBe(1); // /stream said COMPLETED with nothing: /status tells the truth
    expect(fake.count("cancel")).toBe(0);
  });

  it("a failure after the headers went out becomes the in-stream error event, with no charge", async () => {
    const fake = runpod({ queuedMs: 120, error: vllmFailure(400, TOO_MANY_TOKENS) });
    const res = await gateway({ runpod: { headStartMs: 10, keepAliveMs: 30 } })(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const err = dataOf(text).find((d) => d.error)!.error!;
    expect(err.code).toBe("upstream_error");
    expect(err.message).toContain("cannot be greater than");
    expectNoLeak(text);
    expect(text).toContain(": x-request-cost-usd=0.000000");
    expect(events(text).at(-1)).toBe("data: [DONE]");
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect(fake.count("cancel")).toBe(0);
  });

  it("reports a job that failed after some output in-stream and bills what was produced", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = runpod({ batches: [[chunk({ content: "partial" })]], error: vllmFailure(500, "engine died") });
    const body = { ...hello, stream: true };
    const res = await send(chatReq(body));
    const text = await res.text();
    expect(contentOf(text)).toBe("partial");
    expect(text).toContain('"code":"upstream_error"');
    expect((await reservations())[0]!.status).toBe("settled");
    const [row] = await usageRows();
    expect(row!.status).toBe("error");
    expect(row!.cost_micro_usd).toBeGreaterThan(0);
    expect(row!.cost_micro_usd).toBeLessThanOrEqual(reservationFor(body));
    expect(fake.count("cancel")).toBe(0);
  });

  it("gives up on a job whose polls keep failing: 502, cancels it, refunds in full", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = runpod({ streamStatus: 500 });
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_error" } });
    expect(fake.count("stream")).toBe(3);
    await until(() => fake.count("cancel") === 1);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("spaces /stream polls even while output flows, so one stream cannot spend the endpoint's shared rate limit", async () => {
    // Every poll brings output. A poll hands over all that piled up since the last one, so waiting only batches it.
    const parts = ["a", "b", "c", "d", "e"].map((content) => [chunk({ content })]);
    const fake = runpod({ batches: [...parts, [stop + usageChunk(20, 5) + DONE]] });
    const res = await gateway({ runpod: { pollMs: 40 } })(chatReq({ ...hello, stream: true }));
    expect(contentOf(await res.text())).toBe("abcde");
    const polls = fake.calls.filter((c) => c.path.startsWith("/stream/")).map((c) => c.at);
    expect(polls).toHaveLength(6);
    for (let i = 1; i < polls.length; i++) expect(polls[i]! - polls[i - 1]!).toBeGreaterThanOrEqual(38);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(20, 5));
  });

  it("waits out a run of 429s as back-pressure: honors Retry-After, keeps the job, bills exactly the usage", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Polls 2 to 7 are turned away, more in a row than a real failure is allowed; the first says Retry-After: 1.
    const throttled = (kind: string, n: number) =>
      kind === "stream" && n >= 2 && n <= 7
        ? new Response(JSON.stringify({ error: "Too Many Requests" }), { status: 429, headers: n === 2 ? { "retry-after": "1" } : {} })
        : undefined;
    const fake = runpod({ batches: [[chunk({ content: "Hel" })], [chunk({ content: "lo" })], [stop + usageChunk(20, 2) + DONE]] }, { answer: throttled });
    const text = await (await send(chatReq({ ...hello, stream: true }))).text();
    expect(contentOf(text)).toBe("Hello");
    expect(text).not.toContain('"error"');
    expect(text).toContain(": keep-alive"); // the client heard from us through the wait
    const polls = fake.calls.filter((c) => c.path.startsWith("/stream/")).map((c) => c.at);
    expect(polls).toHaveLength(9);
    expect(polls[2]! - polls[1]!).toBeGreaterThanOrEqual(990);
    expect(fake.count("cancel")).toBe(0);
    expect((await usageRows()).map((r) => [r.status, r.cost_micro_usd])).toEqual([["ok", costMicroUsd(20, 2)]]);
    expect(log).toHaveBeenCalledTimes(1); // once per call, not once per 429
    expect(log.mock.calls[0]![0]).toContain("rate-limiting");
  });

  it("still ends a stream throttled for good at the call's deadline: one cancel, billed for what was relayed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = runpod(
      { batches: [[chunk({ content: "abc" })]], hang: true },
      { answer: (kind, n) => (kind === "stream" && n > 1 ? jsonRes({ error: "Too Many Requests" }, 429) : undefined) },
    );
    const text = await (await gateway({ timeoutMs: 300 })(chatReq({ ...hello, stream: true }))).text();
    expect(contentOf(text)).toBe("abc");
    expect(dataOf(text).find((d) => d.error)!.error!.code).toBe("upstream_timeout");
    await until(() => fake.count("cancel") === 1);
    const [row] = await usageRows();
    expect(row!.status).toBe("error");
    expect(row!.cost_micro_usd).toBeGreaterThan(0);
  });

  it("never passes output off as a whole answer when /status cannot tell how the job ended", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // /stream reports a FAILED job as COMPLETED with nothing, so /status is the only witness: unreachable, or the job is gone.
    const witnesses: Array<[() => Response, number]> = [
      [() => jsonRes({ error: "upstream hiccup" }, 503), 3],
      [() => jsonRes({ status: 404, title: "Not Found", detail: "job not found" }, 404), 1],
    ];
    for (const [answer, asked] of witnesses) {
      const fake = runpod({ batches: [[chunk({ content: "partial answ" })]] }, { answer: (kind) => (kind === "status" ? answer() : undefined) });
      const text = await (await send(chatReq({ ...hello, stream: true }))).text();
      expect(contentOf(text)).toBe("partial answ");
      expect(dataOf(text).find((d) => d.error)!.error!.code).toBe("upstream_error");
      expect(fake.count("status")).toBe(asked);
      expect(fake.count("cancel")).toBe(0); // the job is over either way
    }
    const rows = await usageRows();
    expect(rows.map((r) => r.status)).toEqual(["error", "error"]);
    expect(rows.every((r) => r.cost_micro_usd > 0)).toBe(true); // what was relayed is still billed
  });

  it("ends a partial last event before a failure, so the error event is not swallowed by it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The job dies with half an event read: /stream says COMPLETED with nothing, /status says FAILED.
    const half = chunk({ content: "trunc" }).slice(0, 60);
    runpod({ batches: [[chunk({ content: "abc" })], [half]], error: "{'message': 'worker died', 'type': 'worker_error', 'code': None}" });
    const text = await (await send(chatReq({ ...hello, stream: true }))).text();
    const parsed = events(text).flatMap((e) => {
      try {
        return [JSON.parse(e.replace(/^data: /, "")) as { error?: { code: string } }];
      } catch {
        return [];
      }
    });
    expect(parsed.find((d) => d.error)?.error?.code).toBe("upstream_error");
    expect((await usageRows())[0]!.status).toBe("error");
    expectNoLeak(text);

    // A whole last event that only lacks its blank line is kept: [DONE] still ends the job's output.
    const fake = runpod({ batches: [[chunk({ content: "ok" }) + stop + usageChunk(10, 1) + "data: [DONE]"]] });
    const done = await (await send(chatReq({ ...hello, stream: true }))).text();
    expect(contentOf(done)).toBe("ok");
    expect(events(done).at(-1)).toBe("data: [DONE]");
    expect((await usageRows())[1]).toMatchObject({ status: "ok", cost_micro_usd: costMicroUsd(10, 1) });
    expect(fake.count("status")).toBe(0);
    expect(fake.count("cancel")).toBe(0);
  });
});

describe("cancelling the job", () => {
  /** A job that never leaves the queue, given up on at the gateway's timeout: a full refund, and a cancel to send. */
  async function abandon(cancel: (n: number) => Response | undefined, cancelTimeoutMs = 1_000) {
    const fake = runpod({ queuedMs: 60_000 }, { answer: (kind, n) => (kind === "cancel" ? cancel(n) : undefined) });
    const res = await gateway({ timeoutMs: 60, runpod: { headStartMs: 10, cancelTimeoutMs } })(chatReq({ ...hello, stream: true }));
    expect(await res.text()).toContain('"code":"upstream_timeout"');
    expect(await getBalance(ws.id)).toBe(1_000_000);
    return fake;
  }

  it("sends the cancel again after a network error, a 5xx or a 429 (waiting as told) until RunPod takes it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = await abandon((n) => {
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return jsonRes({ error: "internal" }, 503);
      if (n === 3) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return undefined;
    });
    await until(() => fake.jobs[0]!.cancelled);
    expect(fake.count("cancel")).toBe(4);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(4);
    expect(log.mock.calls.flat().join(" ")).not.toContain("cancel");
  });

  it("stops at a 404 (the job is gone) or a refusal, and gives up once cancelTimeoutMs runs out", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let fake = await abandon(() => jsonRes({ status: 404, title: "Not Found", detail: "job not found" }, 404));
    await until(() => fake.count("cancel") === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(1);
    expect(log).not.toHaveBeenCalled();

    fake = await abandon(() => jsonRes({ error: "bad request" }, 400));
    await until(() => log.mock.calls.length === 1);
    expect(fake.count("cancel")).toBe(1);
    expect(log.mock.calls[0]![0]).toBe("[gateway] RunPod cancel of job job-1-u1 answered 400; its time limit will stop it");

    fake = await abandon(() => jsonRes({ error: "internal" }, 500), 150);
    await until(() => log.mock.calls.length === 2);
    const sent = fake.count("cancel");
    expect(sent).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.count("cancel")).toBe(sent);
    expect(log.mock.calls[1]![0]).toBe("[gateway] RunPod cancel of job job-1-u1 answered 500; its time limit will stop it");
  });
});

describe("queuing the job", () => {
  it("/run 401 -> 503 upstream_unavailable, logged, nothing queued, full refund", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = runpod({}, { run: () => jsonRes({ error: `bad key ${UPSTREAM_KEY} for ${JOB_BASE}` }, 401) });
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_unavailable" } });
    expectNoLeak(text);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("upstream answered 401"));
    expect(fake.count("run")).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("retries a cold /run (503) once; the queue absorbs everything after that", async () => {
    const fake = runpod({ batches: [[chunk({ content: "ok" }) + usageChunk(10, 1) + DONE]] }, { run: (n) => (n === 1 ? jsonRes({ error: "warming" }, 503) : undefined) });
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(contentOf(await res.text())).toBe("ok");
    expect(fake.count("run")).toBe(2);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(10, 1));
  });

  it("/run 429 -> 503 upstream_busy with Retry-After", async () => {
    runpod({}, { run: () => jsonRes({ error: "throttled" }, 429) });
    const res = await send(chatReq(hello));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: { code: "upstream_busy" } });
  });
});

describe("non-streaming over the RunPod queue", () => {
  it("polls /status until the job completes, answers its completion and debits exactly the usage", async () => {
    const fake = runpod({ queuedMs: 40, completion: completion("Forks race, one exits 0") });
    const res = await send(chatReq({ ...hello, max_tokens: 2048 }));
    expect(res.status).toBe(200);
    const cost = costMicroUsd(1000, 500);
    expect(res.headers.get("x-request-cost-usd")).toBe((cost / 1e6).toFixed(6));
    const text = await res.text();
    expectNoLeak(text);
    const body = JSON.parse(text) as { model: string; choices: { message: { content: string } }[] };
    expect(body.model).toBe("forkbomb-hosted");
    expect(body.choices[0]!.message.content).toBe("Forks race, one exits 0");
    expect((fake.calls[0]!.body as { input: { body: unknown } }).input.body).toEqual({ messages: hello.messages, max_tokens: 2048, model: UPSTREAM_MODEL, stream: false });
    expect(fake.count("status")).toBeGreaterThan(1);
    expect(fake.count("status")).toBeLessThan(40); // backed off, not spinning
    expect(fake.count("stream")).toBe(0);
    expect(fake.count("cancel")).toBe(0);
    expect(await getBalance(ws.id)).toBe(1_000_000 - cost);
  });

  it("waits out 429s on /status too, and answers the completion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = runpod({ completion: completion("patient") }, { answer: (kind, n) => (kind === "status" && n <= 5 ? jsonRes({ error: "Too Many Requests" }, 429) : undefined) });
    const res = await send(chatReq(hello));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("patient");
    expect(fake.count("status")).toBe(6);
    expect(fake.count("cancel")).toBe(0);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(1000, 500));
  });

  it("FAILED 400 -> 400 upstream_rejected, scrubbed, no charge", async () => {
    const fake = runpod({ error: vllmFailure(400, TOO_MANY_TOKENS) });
    const res = await send(chatReq(hello));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_rejected" } });
    expect(text).toContain("cannot be greater than max_model_len=32768");
    expectNoLeak(text);
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await usageRows()).map((r) => [r.status, r.cost_micro_usd])).toEqual([["error", 0]]);
    expect(fake.count("cancel")).toBe(0);
  });

  it("a worker failure that is not vLLM's answer -> 502 upstream_error, no charge", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runpod({ error: "{'message': 'CUDA out of memory', 'type': 'worker_error', 'code': None}" });
    const res = await send(chatReq(hello));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_error" } });
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("runs to completion when the client leaves, billing the real usage (unchanged semantics)", async () => {
    const fake = runpod({ queuedMs: 60, completion: completion("done anyway", { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }) });
    const ctl = new AbortController();
    const pending = send(chatReq(hello, { signal: ctl.signal }));
    await until(() => fake.count("status") >= 1);
    ctl.abort();
    expect((await pending).status).toBe(200);
    expect(fake.count("cancel")).toBe(0);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(40, 10));
  });

  it("the gateway timeout cancels the job: 504 upstream_timeout with a full refund", async () => {
    const fake = runpod({ hang: true });
    const res = await gateway({ timeoutMs: 100 })(chatReq(hello));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_timeout" } });
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
    expect(await getBalance(ws.id)).toBe(1_000_000);
    await until(() => fake.count("cancel") === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.count("cancel")).toBe(1);
  });
});

describe("transport selection", () => {
  it("uses the queue for RunPod's OpenAI URL by default", async () => {
    const fake = runpod({ completion: completion("queued") });
    expect((await send(chatReq(hello))).status).toBe(200);
    expect(fake.calls.map((c) => c.path.split("/")[1])).toEqual(["run", "status"]);
  });

  it("UPSTREAM_TRANSPORT=openai talks to the OpenAI route directly", async () => {
    vi.stubEnv("UPSTREAM_TRANSPORT", "openai");
    const fake = runpod({});
    const res = await send(chatReq(hello));
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("direct");
    expect(fake.calls.map((c) => c.path)).toEqual(["/openai/v1/chat/completions"]);
  });

  it("UPSTREAM_TRANSPORT=runpod takes the job base URL as it is", async () => {
    vi.stubEnv("UPSTREAM_BASE_URL", JOB_BASE);
    vi.stubEnv("UPSTREAM_TRANSPORT", "runpod");
    const fake = runpod({ completion: completion("queued") });
    expect((await send(chatReq(hello))).status).toBe(200);
    expect(fake.calls[0]!.path).toBe("/run");
  });
});

describe("background work after the client leaves", () => {
  it("hands the platform one promise that ends only after the settle and the job cancel", async () => {
    const fake = runpod({ batches: [[chunk({ content: "abc" })]], hang: true }, { longPollMs: 10_000 });
    const work: Promise<unknown>[] = [];
    const res = await gateway({ waitUntil: (p) => work.push(p) })(chatReq({ ...hello, stream: true }));
    expect(work).toHaveLength(1);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await work[0];
    expect(fake.count("cancel")).toBe(1);
    expect((await reservations())[0]!.status).not.toBe("active");
    expect((await usageRows())[0]!.status).toBe("error");
  });
});
