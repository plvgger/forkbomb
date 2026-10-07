// The metered gateway against a fake upstream (fetch stub, no network) and a fresh PGlite per test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as chatRoute, maxDuration } from "../app/api/v1/chat/completions/route";
import { costMicroUsd, credit, getBalance } from "../lib/server/credits";
import { int, type Db } from "../lib/server/db";
import { chatCompletions, GATEWAY_DEFAULTS, ROUTE_MAX_DURATION_S, type GatewayOptions } from "../lib/server/gateway/chat";
import { parseChatRequest } from "../lib/server/gateway/request";
import { handler } from "../lib/server/http";
import { freshDb, newWorkspace } from "./helpers";

const UPSTREAM = "https://gpu.test.invalid/v1";
const UPSTREAM_KEY = "upstream-secret-key";
const UPSTREAM_MODEL = "upstream-model-test";
const SITE = "https://site.test/api/v1/chat/completions";

let db: Db;
let ws: { id: string; apiKey: string };

/** The gateway with fast retries, wrapped like the route. */
const gateway = (opts: GatewayOptions = {}) => handler((req: Request) => chatCompletions(req, { retryDelayMs: 1, ...opts }));
const send = gateway();

const chatReq = (body: unknown, opts: { key?: string; signal?: AbortSignal } = {}) =>
  new Request(SITE, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.key ?? ws.apiKey}`, "content-type": "application/json" },
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

type UpstreamCall = { url: string; body: Record<string, unknown>; headers: Headers; signal: AbortSignal };
type UpstreamHandler = (call: UpstreamCall, n: number) => Response | Promise<Response>;

/** Stubs fetch with a fake OpenAI-compatible upstream. Anything else fails the test. */
function upstream(fn: UpstreamHandler): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${UPSTREAM}/chat/completions`) throw new Error(`unexpected fetch in test: ${url}`);
      const call = { url, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init!.signal! };
      calls.push(call);
      return fn(call, calls.length);
    }),
  );
  return calls;
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const completion = (message: Record<string, unknown>, usage: unknown = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: UPSTREAM_MODEL,
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage,
});

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: UPSTREAM_MODEL, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const usageChunk = (p: number, c: number) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: UPSTREAM_MODEL, choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })}\n\n`;

/**
 * An SSE body that emits parts one by one. With hang, it then waits for the abort signal.
 * Like real fetch, aborting the signal errors the body.
 */
function sse(parts: string[], signal: AbortSignal, opts: { hang?: boolean; breakAfter?: boolean } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 2));
      if (i < parts.length) return controller.enqueue(enc.encode(parts[i++]!));
      if (opts.breakAfter) return controller.error(new TypeError("terminated"));
      if (!opts.hang) return controller.close();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      controller.error(new DOMException("This operation was aborted", "AbortError"));
    },
  });
  signal.addEventListener("abort", () => body.cancel().catch(() => {}), { once: true });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function reservations() {
  return db.query<{ status: string; amount_micro_usd: unknown }>("SELECT status, amount_micro_usd FROM reservations");
}
async function usageRows() {
  const rows = await db.query<{ cost_micro_usd: unknown; status: string; model: string; input_tokens: number; output_tokens: number }>(
    "SELECT cost_micro_usd, status, model, input_tokens, output_tokens FROM usage ORDER BY id",
  );
  return rows.map((r) => ({ ...r, cost_micro_usd: int(r.cost_micro_usd) }));
}

async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("UPSTREAM_BASE_URL", `${UPSTREAM}/`);
  vi.stubEnv("UPSTREAM_API_KEY", UPSTREAM_KEY);
  vi.stubEnv("UPSTREAM_MODEL", UPSTREAM_MODEL);
  ws = await newWorkspace();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("before the request reaches upstream", () => {
  it("503 upstream_unavailable when no GPU pool is configured, without touching credit", async () => {
    vi.stubEnv("UPSTREAM_BASE_URL", "");
    const calls = upstream(() => jsonRes({}));
    await fund(1_000_000);
    const res = await chatRoute(chatReq(hello));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string; type: string } };
    expect(body.error).toMatchObject({ code: "upstream_unavailable", type: "server_error" });
    expect(body.error.message).toMatch(/not provisioned yet/);
    expect(res.headers.get("retry-after")).toBeNull(); // permanent: clients fail fast instead of retrying
    expect(calls).toHaveLength(0);
    expect(await reservations()).toHaveLength(0);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("401 for a missing or unknown key", async () => {
    upstream(() => jsonRes({}));
    const res = await send(chatReq(hello, { key: "forkbomb_sk_00000000000000000000000000000000" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_api_key", type: "authentication_error" } });
  });

  it("402 insufficient_credits with the remaining balance, without calling upstream", async () => {
    const calls = upstream(() => jsonRes(completion({ role: "assistant", content: "x" })));
    await fund(100);
    const res = await send(chatReq(hello));
    expect(res.status).toBe(402);
    expect(res.headers.get("x-credits-remaining-usd")).toBe("0.000100");
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error).toMatchObject({ code: "insufficient_credits", type: "billing_error" });
    expect(body.error.message).toContain("$0.000100 remaining");
    expect(calls).toHaveLength(0);
    expect(await reservations()).toHaveLength(0);
  });

  it("400 for a malformed body, before reserving", async () => {
    await fund(1_000_000);
    const calls = upstream(() => jsonRes({}));
    const res = await send(chatReq({ messages: "hi" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_messages", type: "invalid_request_error" } });
    expect(calls).toHaveLength(0);
    expect(await reservations()).toHaveLength(0);
  });

  it("429 rate_limited per workspace", async () => {
    vi.stubEnv("RATE_GATEWAY_PER_MINUTE", "2");
    await fund(1_000_000);
    upstream(() => jsonRes(completion({ role: "assistant", content: "ok" })));
    expect((await send(chatReq(hello))).status).toBe(200);
    expect((await send(chatReq(hello))).status).toBe(200);
    const limited = await send(chatReq(hello));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("non-streaming", () => {
  it("forwards a clean request, debits exactly the usage cost and hides the upstream", async () => {
    await fund(1_000_000);
    const calls = upstream(() => jsonRes(completion({ role: "assistant", content: "Forks race, one exits 0" })));
    const res = await chatRoute(
      chatReq({ ...hello, temperature: 0.1, user: "u-1", logprobs: true, max_tokens: 2048, stream: false }),
    );
    expect(res.status).toBe(200);

    const cost = costMicroUsd(1000, 500); // 600 + 1200 micro-USD
    expect(cost).toBe(1_800);
    expect(res.headers.get("x-request-cost-usd")).toBe("0.001800");
    expect(res.headers.get("x-credits-remaining-usd")).toBe("0.998200");
    expect(await getBalance(ws.id)).toBe(1_000_000 - cost);

    const text = await res.text();
    expect(text).not.toContain("gpu.test.invalid");
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(text).not.toContain(UPSTREAM_MODEL);
    const body = JSON.parse(text) as { model: string; choices: { message: { content: string } }[]; usage: unknown };
    expect(body.model).toBe("forkbomb-hosted");
    expect(body.choices[0]!.message.content).toBe("Forks race, one exits 0");
    expect(body.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 500 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(calls[0]!.body).toEqual({
      messages: hello.messages,
      temperature: 0.1,
      max_tokens: 2048,
      model: UPSTREAM_MODEL,
      stream: false,
    });

    expect(await usageRows()).toEqual([
      { cost_micro_usd: cost, status: "ok", model: UPSTREAM_MODEL, input_tokens: 1000, output_tokens: 500 },
    ]);
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
  });

  it("passes tools, tool_choice, tool messages and tool_calls through intact", async () => {
    await fund(1_000_000);
    const tools = [
      {
        type: "function",
        function: {
          name: "run_tests",
          description: "Run the test suite",
          parameters: { type: "object", properties: { filter: { type: "string" } }, required: ["filter"] },
        },
      },
    ];
    const messages = [
      { role: "system", content: "You are a fork." },
      { role: "user", content: "Fix the bug." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "run_tests", arguments: "{\"filter\":\"all\"}" } }] },
      { role: "tool", tool_call_id: "call_0", content: "2 failed" },
    ];
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "run_tests", arguments: "{\"filter\":\"auth\"}" } }];
    const calls = upstream(() =>
      jsonRes({ ...completion({ role: "assistant", content: null, tool_calls: toolCalls }), choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }] }),
    );
    const res = await send(chatReq({ model: "hosted", messages, tools, tool_choice: "required", parallel_tool_calls: false }));
    expect(res.status).toBe(200);
    expect(calls[0]!.body).toMatchObject({ messages, tools, tool_choice: "required", parallel_tool_calls: false });
    const body = (await res.json()) as { choices: { message: { tool_calls: unknown }; finish_reason: string }[] };
    expect(body.choices[0]!.message.tool_calls).toEqual(toolCalls);
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("refunds the full reservation when upstream fails with 500", async () => {
    await fund(1_000_000);
    const calls = upstream(() => jsonRes({ error: { message: `boom at ${UPSTREAM}` } }, 500));
    const res = await send(chatReq(hello));
    expect(res.status).toBe(502);
    expect(res.headers.get("x-request-cost-usd")).toBe("0.000000");
    expect(res.headers.get("x-credits-remaining-usd")).toBe("1.000000");
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_error", type: "server_error" } });
    expect(text).not.toContain("gpu.test.invalid");
    expect(calls).toHaveLength(1); // 500 is not a cold-start status: no retry
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
    expect((await usageRows()).map((u) => [u.cost_micro_usd, u.status])).toEqual([[0, "error"]]);
  });

  it("retries a cold start (503) once and then succeeds", async () => {
    await fund(1_000_000);
    const calls = upstream((_, n) => (n === 1 ? jsonRes({ error: "warming" }, 503) : jsonRes(completion({ role: "assistant", content: "ok" }))));
    const res = await send(chatReq(hello));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(1000, 500));
  });

  it("gives up after one retry with 503 upstream_unavailable and a full refund", async () => {
    await fund(1_000_000);
    const calls = upstream(() => jsonRes({ error: "warming" }, 502));
    const res = await send(chatReq(hello));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(await res.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
    expect(calls).toHaveLength(2);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("retries a refused connection once, then 503 with a full refund", async () => {
    await fund(1_000_000);
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        throw new TypeError("fetch failed");
      }),
    );
    const res = await send(chatReq(hello));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
    expect(res.headers.get("retry-after")).toBe("10"); // transient: clients may retry
    expect(n).toBe(2);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("maps upstream 400 to upstream_rejected with a scrubbed message and no charge", async () => {
    await fund(1_000_000);
    upstream(() => jsonRes({ object: "error", message: `context too long for ${UPSTREAM} key ${UPSTREAM_KEY}`, type: "BadRequestError" }, 400));
    const res = await send(chatReq(hello));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_rejected" } });
    expect(text).toContain("context too long");
    expect(text).not.toContain("gpu.test.invalid");
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("504 upstream_timeout with a full refund when upstream hangs", async () => {
    await fund(1_000_000);
    upstream(
      ({ signal }) =>
        new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const res = await gateway({ timeoutMs: 30 })(chatReq(hello));
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_timeout" } });
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
  });

  it("gives up before the route's maxDuration so a timed-out call always settles (regression)", async () => {
    expect(maxDuration).toBe(ROUTE_MAX_DURATION_S);
    expect(ROUTE_MAX_DURATION_S * 1000 - GATEWAY_DEFAULTS.timeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it("measures the timeout from request start, not from the upstream call (regression)", async () => {
    await fund(1_000_000);
    upstream(
      ({ signal }) =>
        new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const t0 = Date.now();
    // 1.9s of a 2s budget already went before the gateway was called: upstream gets what is left.
    const res = await gateway({ timeoutMs: 2_000, startedAt: t0 - 1_900 })(chatReq(hello));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: "upstream_timeout", message: expect.stringContaining("within 2s") } });
    expect((await reservations()).map((r) => r.status)).toEqual(["settled"]);
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("caps the charge at the reservation when upstream reports more than was reserved", async () => {
    await fund(1_000_000);
    upstream(() => jsonRes(completion({ role: "assistant", content: "x" }, { prompt_tokens: 5_000_000, completion_tokens: 0 })));
    const body = { ...hello, max_tokens: 16 };
    const res = await send(chatReq(body));
    expect(res.status).toBe(200);
    expect(await getBalance(ws.id)).toBe(1_000_000 - reservationFor(body));
  });

  it("estimates from the reply when upstream omits usage", async () => {
    await fund(1_000_000);
    upstream(() => jsonRes(completion({ role: "assistant", content: "y".repeat(300) }, null)));
    const res = await send(chatReq(hello));
    expect(res.status).toBe(200);
    const est = parseChatRequest(hello).estimatedInputTokens;
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(est, 100));
  });
});

describe("streaming", () => {
  const parts = [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: "Hel" }),
    chunk({ content: "lo" }),
    chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    usageChunk(200, 2),
    "data: [DONE]\n\n",
  ];

  const events = (text: string) => text.split("\n\n").filter(Boolean);
  const dataOf = (text: string) =>
    events(text)
      .filter((e) => e.startsWith("data: ") && e !== "data: [DONE]")
      .map((e) => JSON.parse(e.slice(6)) as { model: string; choices: { delta: { content?: string } }[]; usage?: unknown });

  it("pipes chunks through, requests usage upstream, and debits exactly the reported usage", async () => {
    await fund(1_000_000);
    const calls = upstream(({ signal }) => sse(parts, signal));
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reserved = reservationFor({ ...hello, stream: true });
    expect(res.headers.get("x-credits-reserved-usd")).toBe((reserved / 1e6).toFixed(6));
    expect(res.headers.get("x-credits-remaining-usd")).toBe(((1_000_000 - reserved) / 1e6).toFixed(6));

    const text = await res.text();
    expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: UPSTREAM_MODEL });
    const data = dataOf(text);
    expect(data.map((d) => d.choices[0]?.delta.content ?? "").join("")).toBe("Hello");
    expect(data.every((d) => d.model === "forkbomb-hosted")).toBe(true);
    expect(data.some((d) => "usage" in d)).toBe(false); // the client did not ask for it
    expect(text).not.toContain(UPSTREAM_MODEL);

    const cost = costMicroUsd(200, 2);
    expect(events(text).slice(-2)).toEqual([
      `: x-request-cost-usd=${(cost / 1e6).toFixed(6)} x-credits-remaining-usd=${((1_000_000 - cost) / 1e6).toFixed(6)}`,
      "data: [DONE]",
    ]);
    expect(await getBalance(ws.id)).toBe(1_000_000 - cost);
    expect(await usageRows()).toEqual([{ cost_micro_usd: cost, status: "ok", model: UPSTREAM_MODEL, input_tokens: 200, output_tokens: 2 }]);
  });

  it("forwards the usage chunk when the client asks for it", async () => {
    await fund(1_000_000);
    upstream(({ signal }) => sse(parts, signal));
    const res = await send(chatReq({ ...hello, stream: true, stream_options: { include_usage: true } }));
    const data = dataOf(await res.text());
    expect(data.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 2 }, model: "forkbomb-hosted" });
  });

  it("streams tool call deltas intact", async () => {
    await fund(1_000_000);
    const tc = (args: string, first = false) =>
      chunk({ tool_calls: [{ index: 0, ...(first ? { id: "call_9", type: "function", function: { name: "edit_file", arguments: args } } : { function: { arguments: args } }) }] });
    upstream(({ signal }) => sse([tc("", true), tc('{"path":'), tc('"a.ts"}'), usageChunk(50, 9), "data: [DONE]\n\n"], signal));
    const res = await send(chatReq({ ...hello, stream: true, tools: [{ type: "function", function: { name: "edit_file", parameters: {} } }] }));
    const deltas = dataOf(await res.text()).map((d) => d.choices[0]!.delta as { tool_calls: { function: { arguments: string; name?: string }; id?: string }[] });
    expect(deltas[0]!.tool_calls[0]).toMatchObject({ id: "call_9", function: { name: "edit_file" } });
    expect(deltas.map((d) => d.tool_calls[0]!.function.arguments).join("")).toBe('{"path":"a.ts"}');
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(50, 9));
  });

  it("settles and closes the reservation when the client aborts mid-stream", async () => {
    await fund(1_000_000);
    const calls = upstream(({ signal }) => sse([chunk({ content: "abc" }), chunk({ content: "def" })], signal, { hang: true }));
    const body = { ...hello, stream: true };
    const res = await send(chatReq(body));
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("abc");
    await reader.cancel();

    await until(async () => (await reservations())[0]!.status !== "active");
    expect(calls[0]!.signal.aborted).toBe(true); // the GPU stops generating
    const est = parseChatRequest(body).estimatedInputTokens;
    const [row] = await usageRows();
    expect(row!.status).toBe("error");
    expect(row!.input_tokens).toBe(est);
    expect(row!.output_tokens).toBeGreaterThanOrEqual(1);
    expect(row!.cost_micro_usd).toBeLessThanOrEqual(reservationFor(body));
    expect(await getBalance(ws.id)).toBe(1_000_000 - row!.cost_micro_usd);
  });

  it("settles when the request signal aborts while nobody is reading", async () => {
    await fund(1_000_000);
    const calls = upstream(({ signal }) => sse([chunk({ content: "abc" })], signal, { hang: true }));
    const ctl = new AbortController();
    const res = await send(chatReq({ ...hello, stream: true }, { signal: ctl.signal }));
    expect(res.status).toBe(200);
    ctl.abort();
    await until(async () => (await reservations())[0]!.status !== "active");
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await usageRows())[0]!.status).toBe("error");
  });

  it("reports a mid-stream upstream failure in-stream and settles for what was produced", async () => {
    await fund(1_000_000);
    upstream(({ signal }) => sse([chunk({ content: "partial" })], signal, { breakAfter: true }));
    const body = { ...hello, stream: true };
    const res = await send(chatReq(body));
    const text = await res.text();
    expect(text).toContain("partial");
    expect(text).toContain('"code":"upstream_error"');
    expect(text).toMatch(/: x-request-cost-usd=/);
    expect((await reservations())[0]!.status).toBe("settled");
    const [row] = await usageRows();
    expect(row!.status).toBe("error");
    expect(row!.cost_micro_usd).toBeGreaterThan(0);
    expect(row!.cost_micro_usd).toBeLessThanOrEqual(reservationFor(body));
  });

  it("charges nothing when the stream breaks before any output", async () => {
    await fund(1_000_000);
    upstream(({ signal }) => sse([], signal, { breakAfter: true }));
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(await res.text()).toContain('"code":"upstream_error"');
    expect(await getBalance(ws.id)).toBe(1_000_000);
  });

  it("treats a non-SSE answer to a streaming request as an upstream failure: scrubbed, no charge (regression)", async () => {
    await fund(1_000_000);
    upstream(() => jsonRes({ error: { message: `worker failed at ${UPSTREAM}` } }));
    const res = await send(chatReq({ ...hello, stream: true }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_error" } });
    expect(text).toContain("worker failed");
    expect(text).not.toContain("gpu.test.invalid");
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await usageRows()).map((r) => [r.status, r.cost_micro_usd])).toEqual([["error", 0]]);
  });

  it("never forwards upstream comments or non-JSON data unscrubbed (regression)", async () => {
    await fund(1_000_000);
    upstream(({ signal }) =>
      sse([`: served by ${UPSTREAM} key ${UPSTREAM_KEY}\n\n`, `data: oops ${UPSTREAM}/x\n\n`, chunk({ content: "hi" }), usageChunk(10, 1), "data: [DONE]\n\n"], signal),
    );
    const res = await send(chatReq({ ...hello, stream: true }));
    const text = await res.text();
    expect(events(text)[0]).toBe(": keep-alive");
    expect(text).toContain("data: oops [upstream]");
    expect(text).not.toContain("gpu.test.invalid");
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(await getBalance(ws.id)).toBe(1_000_000 - costMicroUsd(10, 1));
  });

  it("charges nothing and records an error when a stream ends without any output (regression)", async () => {
    await fund(1_000_000);
    upstream(({ signal }) => sse([chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"], signal));
    const res = await send(chatReq({ ...hello, stream: true }));
    const text = await res.text();
    expect(events(text).at(-1)).toBe("data: [DONE]");
    expect(text).toContain(": x-request-cost-usd=0.000000");
    expect(await getBalance(ws.id)).toBe(1_000_000);
    expect((await usageRows()).map((r) => [r.status, r.cost_micro_usd])).toEqual([["error", 0]]);
  });

  it("times out a stalled stream, reports it, and closes the reservation", async () => {
    await fund(1_000_000);
    upstream(({ signal }) => sse([chunk({ content: "slow" })], signal, { hang: true }));
    const res = await gateway({ timeoutMs: 60 })(chatReq({ ...hello, stream: true }));
    const text = await res.text();
    expect(text).toContain('"code":"upstream_timeout"');
    expect((await reservations())[0]!.status).toBe("settled");
  });
});

describe("concurrency", () => {
  it("20 parallel requests with balance for 5 never overspend", async () => {
    const reserved = reservationFor(hello);
    const start = reserved * 6 - 1; // room for 5 holds, not 6
    await fund(start);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = upstream(async () => {
      await gate;
      return jsonRes(completion({ role: "assistant", content: "ok" }, { prompt_tokens: 40, completion_tokens: 10 }));
    });

    let rejected = 0;
    const pending = Array.from({ length: 20 }, () =>
      send(chatReq(hello)).then((res) => {
        if (res.status === 402) rejected++;
        return res;
      }),
    );
    // Hold every upstream response until each request has either reserved (and called upstream) or been refused.
    await until(async () => calls.length + rejected === 20, 10_000);
    expect(await getBalance(ws.id)).toBe(start - 5 * reserved);
    release();

    const statuses = (await Promise.all(pending)).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 402)).toHaveLength(15);
    expect(calls).toHaveLength(5);
    expect(await getBalance(ws.id)).toBe(start - 5 * costMicroUsd(40, 10));
    expect((await reservations()).every((r) => r.status === "settled")).toBe(true);
  });
});
