import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPrompt } from "../src/agent.js";
import { DEFAULT_HOSTED_URL, HOME_ENV, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "../src/brand.js";
import {
  type ChatCompletion,
  type ChatRequest,
  type CreditGate,
  HOSTED_TOOLS,
  HostedClient,
  HostedError,
  chargedSince,
  checkBaseUrl,
  formatCredits,
  hostedSettings,
  runHostedFork,
} from "../src/engines/hosted.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { type RunOptions, runRace } from "../src/orchestrator.js";
import { Workspace } from "../src/tools.js";
import { Semaphore } from "../src/util.js";
import { tempDir, writeTree } from "./helpers.js";

const KEY = "forkbomb_sk_T3stKeyAbCdEfGhIjKlMnOpQrStUvWx";

const REPO = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "math.js": "export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a + b;\n",
  "math.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, mul } from "./math.js";\n' +
    'test("sum", () => assert.equal(sum(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
};

// ---------- a scriptable OpenAI-compatible gateway on loopback ----------

interface Msg {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  headers: IncomingHttpHeaders;
  body: { model?: string; messages: Msg[]; tools?: Array<{ function: { name: string } }> } & Record<string, unknown>;
  /** Resolves (with performance.now()) when the connection closes, answered or not. */
  closed: Promise<number>;
  /** The client's port: the same port on two calls means one reused connection. */
  socket: number | undefined;
}
interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Raw server-sent events, written one piece at a time, in place of `body`. */
  sse?: string[];
  /** Leave the stream open after the last piece, like a model still generating. */
  hang?: boolean;
}

const servers: Array<() => void> = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
  delete process.env[HOSTED_KEY_ENV];
});

async function gateway(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString()));
    req.on("end", async () => {
      const call: Call = {
        method: req.method ?? "",
        path: (req.url ?? "").split("?")[0]!,
        auth: req.headers.authorization,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : { messages: [] },
        closed: new Promise((done) => res.on("close", () => done(performance.now()))),
        socket: req.socket.remotePort,
      };
      calls.push(call);
      const r = await handler(call);
      if (r.delayMs) await new Promise((d) => setTimeout(d, r.delayMs));
      if (res.destroyed) return;
      // A streaming request gets its completion as the gateway streams it; errors stay plain JSON.
      const sse = r.sse ?? (call.body.stream === true && (r.status ?? 200) < 300 ? toSse(r.body as ChatCompletion, r.headers?.["x-request-cost-usd"]) : null);
      if (sse) {
        const { "x-request-cost-usd": _, ...headers } = r.headers ?? {};
        res.writeHead(r.status ?? 200, { "content-type": "text/event-stream; charset=utf-8", "x-credits-remaining-usd": "4.200000", ...headers });
        for (const [i, piece] of sse.entries()) {
          if (res.destroyed) return;
          // Like the gateway, the last piece and the end of the body go out together.
          if (i === sse.length - 1 && !r.hang) return void res.end(piece);
          res.write(piece);
          await new Promise((d) => setImmediate(d));
        }
        return;
      }
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  servers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const chats = () => calls.filter((c) => c.path.endsWith("/chat/completions"));
  return { url: `http://127.0.0.1:${port}/api/v1`, port, calls, chats };
}

let seq = 0;
function call(name: string, args: Record<string, unknown> | string, id: string | null = `call_${++seq}`) {
  return {
    ...(id ? { id } : {}),
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function reply(
  message: { content?: string | null; tool_calls?: unknown[] },
  finish: string = message.tool_calls?.length ? "tool_calls" : "stop",
  cost: string | null = "0.0015",
): Reply {
  const body: ChatCompletion = {
    id: `cmpl_${++seq}`,
    model: "forkbomb-coder",
    choices: [{ index: 0, message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls as never } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
  return { body, headers: cost === null ? {} : { "x-request-cost-usd": cost } };
}

const apiError = (status: number, code: string, message: string): Reply => ({ status, body: { error: { message, type: code, code } } });

/** Prices the test gateway charges, as /me reports them. */
const PRICES = { inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.4 };

/**
 * What the real gateway bills for a stream the client hung up on, worked out the way web/lib/server/gateway does it
 * (estimateInputTokens over the body it received, Meter.estimate for the output, costMicroUsd rounding up), in µUSD.
 */
function gatewayHangUpMicro(body: Call["body"], outBytes: number, outChunks: number): number {
  const input = 16 + body.messages.length * 8 + Math.ceil(Buffer.byteLength(JSON.stringify([body.messages, body.tools ?? null, body.tool_choice ?? null, body.response_format ?? null])) / 3);
  const output = Math.max(outChunks, Math.ceil(outBytes / 3));
  return Math.ceil((input * 600_000 + output * 2_400_000) / 1e6);
}

const meReply = (balanceMicroUsd: number): Reply => ({
  body: { workspace: { id: "ws_test", label: null, createdAt: "2026-10-01T00:00:00.000Z" }, credits: { balanceMicroUsd, balanceUsd: balanceMicroUsd / 1e6 }, pricing: { ...PRICES, model: "forkbomb-hosted" } },
});

/** One chat.completion.chunk event, shaped like the pool's. */
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "forkbomb-hosted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (prompt = 100, completion = 20) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "forkbomb-hosted", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`;
const settled = (cost: string, remaining = "4.200000") => `: x-request-cost-usd=${cost} x-credits-remaining-usd=${remaining}\n\n`;
const streamError = (type: string, code: string, message: string) => `data: ${JSON.stringify({ error: { message, type, code } })}\n\n`;

/**
 * A completion as the gateway streams it: role, content in two pieces, each tool call (id and name first,
 * then its arguments in two pieces), finish, usage, the settled cost as a comment (when priced), [DONE].
 */
function toSse(c: ChatCompletion, cost: string | undefined): string[] {
  const choice = c.choices[0]!;
  const m = choice.message;
  const halves = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];
  const out = [chunk({ role: "assistant", content: "" }), ": keep-alive\n\n"];
  if (m.content) for (const piece of halves(m.content)) out.push(chunk({ content: piece }));
  (m.tool_calls ?? []).forEach((t, index) => {
    out.push(chunk({ tool_calls: [{ index, ...(t.id ? { id: t.id } : {}), type: "function", function: { name: t.function?.name } }] }));
    for (const piece of halves(t.function?.arguments ?? "")) out.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
  });
  out.push(chunk({}, choice.finish_reason), usageChunk(c.usage?.prompt_tokens, c.usage?.completion_tokens));
  if (cost !== undefined) out.push(settled(cost));
  out.push("data: [DONE]\n\n");
  return out;
}

/** Which turn of the conversation this request is, and which strategy the fork was given. */
function turnOf(c: Call): { turn: number; strategy: string } {
  const user = String(c.body.messages.find((m) => m.role === "user")?.content ?? "");
  return {
    turn: c.body.messages.filter((m) => m.role === "assistant").length,
    strategy: /Your strategy \(([^)]+)\)/.exec(user)?.[1] ?? "",
  };
}

function fork(url: string, opts: { maxTurns?: number; retries?: number } = {}) {
  const root = tempDir("hosted");
  writeTree(root, REPO);
  const workspace = new Workspace({ root, tmp: `${root}-tmp`, network: false, gitWrite: false }, { bashTimeoutMs: 20_000, maxOutput: 10_000 });
  const bus = new EventBus();
  const ctl = new AbortController();
  const credit: CreditGate = { exhausted: null };
  const client = new HostedClient({ baseUrl: url, apiKey: KEY, maxRetries: opts.retries ?? 3, retryBaseMs: 1 });
  const cfg = {
    id: "1.01",
    workspace,
    client,
    system: systemPrompt({ bashTimeoutS: 20, engine: "hosted" }),
    prompt: "Task: make the tests pass\nTest command: node --test\n\nYour strategy (surgeon): go",
    maxTurns: opts.maxTurns ?? 10,
    signal: ctl.signal,
    abortReason: () => "killed" as const,
    bus,
    apiSlots: new Semaphore(4),
    credit,
  };
  return { root, bus, ctl, credit, cfg };
}

function options(repo: string, client: HostedClient, over: Partial<RunOptions> = {}): RunOptions {
  return {
    runId: `h${Math.floor(performance.now() * 1000)}`,
    repo,
    task: "make the tests pass",
    testCmd: "node --test",
    forks: 2,
    rounds: 1,
    mode: "race",
    hosted: client,
    effort: "medium",
    maxTurns: 10,
    forkTimeoutMs: 30_000,
    bashTimeoutMs: 20_000,
    testTimeoutMs: 30_000,
    maxOutput: 10_000,
    network: false,
    sandbox: true,
    protect: DEFAULT_PROTECT,
    apply: false,
    keepForks: false,
    runsDir: tempDir("hosted-runs"),
    concurrency: 8,
    ...over,
  };
}

const fixSum = () => call("edit", { command: "str_replace", path: "/workspace/math.js", old_str: "a - b", new_str: "a + b" });
const fixMul = () => call("edit", { command: "str_replace", path: "/workspace/math.js", old_str: "mul = (a, b) => a + b", new_str: "mul = (a, b) => a * b" });

// ---------- tests ----------

describe("hosted engine: one fork", () => {
  it("views, edits and runs the tests in its sandboxed clone, then finishes", async () => {
    const script = [
      () => reply({ tool_calls: [call("edit", { command: "view", path: "/workspace/math.js" })] }),
      () => reply({ tool_calls: [call("edit", { command: "view", path: "/etc/passwd" })] }),
      () => reply({ content: "Fixing both.", tool_calls: [fixSum(), fixMul()] }),
      () => reply({ tool_calls: [call("bash", { command: "node --test 2>&1 | tail -8" })] }),
      () => reply({ content: "Fixed sum and mul." }),
    ];
    const gw = await gateway((c) => script[turnOf(c).turn]!());
    const { root, bus, cfg } = fork(gw.url);
    const res = await runHostedFork(cfg);

    expect(res).toMatchObject({ reason: "end_turn", turns: 5, inputTokens: 500, outputTokens: 100, summary: "Fixed sum and mul." });
    expect(res.costUsd).toBeCloseTo(0.0075, 10);
    expect(readFileSync(join(root, "math.js"), "utf8")).toBe("export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");

    const chats = gw.chats();
    expect(chats).toHaveLength(5);
    for (const c of chats) expect(c.auth).toBe(`Bearer ${KEY}`);
    // Streams end cleanly, so turns reuse the connection (one sent the instant the last ended may open another).
    expect(new Set(chats.map((c) => c.socket)).size).toBeLessThan(chats.length);
    expect(chats[0]!.body.model).toBe("hosted");
    expect(chats[0]!.body.stream).toBe(true);
    expect(chats[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(chats[0]!.headers.accept).toBe("text/event-stream");
    expect(chats[0]!.body.tools?.map((t) => t.function.name)).toEqual(["bash", "edit"]);
    expect(chats[0]!.body.messages[0]).toMatchObject({ role: "system" });
    expect(chats[0]!.body.messages[0]!.content).toContain("Give it paths under /workspace");
    expect(chats[0]!.body.messages[0]!.content).toContain("there is no /workspace directory in the shell");

    // Each tool result answers its call, and carries what the workspace said.
    const last = (i: number) => chats[i]!.body.messages.at(-1)!;
    const prevCall = (i: number) => chats[i - 1]!.body.messages.length; // sanity: history only grows
    expect(last(1)).toMatchObject({ role: "tool", tool_call_id: chats[1]!.body.messages.at(-2)!.tool_calls![0]!.id });
    expect(last(1).content).toContain("sum = (a, b) => a - b");
    expect(last(2).content).toMatch(/^error: path is outside the workspace/);
    expect(chats[3]!.body.messages.slice(-2).map((m) => m.content)).toEqual(["Edited /workspace/math.js.", "Edited /workspace/math.js."]);
    expect(last(4).content).toMatch(/pass 2\b/);
    expect(last(4).content).toMatch(/fail 0\b/);

    // Append-only: every request starts with the previous one, unchanged.
    for (let i = 1; i < chats.length; i++) {
      expect(chats[i]!.body.messages.length).toBeGreaterThan(prevCall(i));
      expect(chats[i]!.body.messages.slice(0, chats[i - 1]!.body.messages.length)).toEqual(chats[i - 1]!.body.messages);
    }

    const tools = bus.history.filter((e) => e.type === "tool");
    expect(tools.map((e) => e.type === "tool" && [e.tool, e.ok, e.summary])).toEqual([
      ["edit", true, "view /workspace/math.js"],
      ["edit", false, "view failed"],
      ["edit", true, "edit /workspace/math.js"],
      ["edit", true, "edit /workspace/math.js"],
      ["bash", true, "node --test 2>&1 | tail -8"],
    ]);
    expect(bus.history.some((e) => e.type === "note" && e.text === "Fixing both.")).toBe(true);
    expect(JSON.stringify(bus.history)).not.toContain(KEY);
  });

  it("survives malformed tool JSON, unknown tools, missing ids and output-limit cut-offs", async () => {
    const script = [
      () =>
        reply({
          tool_calls: [
            call("bash", '{"command": "echo hi"', "c_bad"),
            call("rm_rf", "{}", "c_unknown"),
            call("bash", '["echo", "hi"]', null),
          ],
        }),
      () => reply({ content: "partial thought" }, "length"),
      () => reply({ tool_calls: [call("bash", '{"command": "ec', "c_cut")] }, "length"),
      () => reply({ content: "Recovered." }),
    ];
    const gw = await gateway((c) => script[turnOf(c).turn]!());
    const { bus, cfg } = fork(gw.url);
    const res = await runHostedFork(cfg);
    expect(res.reason).toBe("end_turn");
    expect(res.summary).toBe("Recovered.");

    const chats = gw.chats();
    const results = chats[1]!.body.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ tool_call_id: "c_bad" });
    expect(results[0]!.content).toMatch(/not valid JSON/);
    expect(results[1]).toMatchObject({ tool_call_id: "c_unknown" });
    expect(results[1]!.content).toMatch(/unknown tool "rm_rf"/);
    // The server left the third call's id out; the engine named it, and the result points at that name.
    const filledId = chats[1]!.body.messages.find((m) => m.role === "assistant")!.tool_calls![2]!.id;
    expect(filledId).toMatch(/^call_1\.01_/);
    expect(results[2]).toMatchObject({ tool_call_id: filledId });
    expect(results[2]!.content).toMatch(/must be a JSON object/);

    expect(chats[2]!.body.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/output limit/) });
    expect(chats[3]!.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c_cut", content: expect.stringMatching(/cut off by the output limit/) });

    const tools = bus.history.filter((e) => e.type === "tool");
    expect(tools.map((e) => e.type === "tool" && e.ok)).toEqual([false, false, false]);
  });

  it("backs off and retries on 429, then carries on", async () => {
    let n = 0;
    const gw = await gateway(() => (++n <= 2 ? { ...apiError(429, "rate_limited", "slow down"), headers: { "retry-after": "0" } } : reply({ content: "ok" })));
    const res = await runHostedFork(fork(gw.url).cfg);
    expect(res.reason).toBe("end_turn");
    expect(gw.chats()).toHaveLength(3);
    expect(res.turns).toBe(1);
  });

  it("gives up on 429 after the retry budget", async () => {
    const gw = await gateway(() => apiError(429, "rate_limited", "slow down"));
    const res = await runHostedFork(fork(gw.url, { retries: 2 }).cfg);
    expect(res.reason).toBe("error");
    expect(res.error).toMatch(/rate limited by the hosted gateway after 2 retries/);
    expect(gw.chats()).toHaveLength(3);
  });

  it("explains 503, 401 and 402 without retrying them", async () => {
    const cases: Array<[Reply, RegExp]> = [
      [
        apiError(503, "upstream_unavailable", "The hosted GPU pool is not provisioned yet."),
        /hosted pool is unavailable \(upstream_unavailable: The hosted GPU pool is not provisioned yet\.\)\. Use --engine api/,
      ],
      [apiError(401, "invalid_api_key", "Invalid API key"), new RegExp(`rejected your API key \\(invalid_api_key\\)\\. Check ${HOSTED_KEY_ENV}`)],
      [apiError(402, "insufficient_credits", "Insufficient credits: balance $0.000120"), /^out of credit: burn \$FORKBOMB to top up at http:\/\/127\.0\.0\.1:\d+\/app \(Insufficient credits: balance \$0\.000120\)$/],
    ];
    for (const [r, want] of cases) {
      const gw = await gateway(() => r);
      const { cfg, credit } = fork(gw.url);
      const res = await runHostedFork(cfg);
      expect(res.reason).toBe("error");
      expect(res.error).toMatch(want);
      expect(res.error).not.toContain(KEY);
      expect(gw.chats()).toHaveLength(1);
      expect(credit.exhausted !== null).toBe(r.status === 402);
    }
  });

  it("retries a busy or warming pool (503 with Retry-After or upstream_busy), then carries on (regression)", async () => {
    const busy = { ...apiError(503, "upstream_busy", "The hosted GPU pool is at capacity. Retry shortly."), headers: { "retry-after": "0" } };
    const warming = { ...apiError(503, "upstream_unavailable", "The hosted GPU pool is warming up."), headers: { "retry-after": "0" } };
    const busyNoHeader = apiError(503, "upstream_busy", "The hosted GPU pool is at capacity. Retry shortly.");
    let n = 0;
    const gw = await gateway(() => [busy, warming, busyNoHeader][n++] ?? reply({ content: "ok" }));
    const res = await runHostedFork(fork(gw.url).cfg);
    expect(res.reason).toBe("end_turn");
    expect(gw.chats()).toHaveLength(4);
  });

  it("gives up on a busy pool after the retry budget with advice that fits", async () => {
    const gw = await gateway(() => ({ ...apiError(503, "upstream_busy", "The hosted GPU pool is at capacity. Retry shortly."), headers: { "retry-after": "0" } }));
    const res = await runHostedFork(fork(gw.url, { retries: 2 }).cfg);
    expect(res.reason).toBe("error");
    expect(res.error).toMatch(/hosted pool is at capacity after 2 retries \(upstream_busy: .*\)\. Try again shortly/);
    expect(res.error).not.toMatch(/not provisioned/);
    expect(gw.chats()).toHaveLength(3);
  });

  it("reports an unreachable gateway after retrying", async () => {
    const gw = await gateway(() => reply({ content: "never" }));
    for (const close of servers.splice(0)) close();
    const res = await runHostedFork(fork(gw.url, { retries: 2 }).cfg);
    expect(res.reason).toBe("error");
    expect(res.error).toMatch(/can't reach the hosted gateway at 127\.0\.0\.1:\d+/);
  });

  it("doesn't call the gateway once the run is out of credit", async () => {
    const gw = await gateway(() => reply({ content: "should not be called" }));
    const { cfg, credit } = fork(gw.url);
    credit.exhausted = "out of credit: burn $FORKBOMB to top up";
    const res = await runHostedFork(cfg);
    expect(res).toMatchObject({ reason: "error", turns: 0, error: "out of credit: burn $FORKBOMB to top up" });
    expect(gw.chats()).toHaveLength(0);
  });

  it("stops promptly when killed mid-request", async () => {
    const gw = await gateway(() => ({ ...reply({ content: "late" }), delayMs: 10_000 }));
    const { cfg, ctl } = fork(gw.url);
    setTimeout(() => ctl.abort(), 200);
    const t0 = performance.now();
    const res = await runHostedFork(cfg);
    expect(res.reason).toBe("killed");
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("prices the turn it hangs up on the way the gateway bills it, and calls the cost unknown without prices (regression)", async () => {
    const slow = (): Reply => ({ body: null, sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "Let me look ✓" }), chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: '{"comm' } }] })], hang: true });
    for (const pricing of [PRICES, undefined]) {
      const gw = await gateway(slow);
      const { cfg, ctl } = fork(gw.url);
      cfg.client = new HostedClient({ baseUrl: gw.url, apiKey: KEY, retryBaseMs: 1, ...(pricing ? { pricing } : {}) });
      setTimeout(() => ctl.abort(), 300);
      const res = await runHostedFork(cfg);
      expect(res.reason).toBe("killed");
      if (pricing) {
        // "Let me look ✓" is 15 bytes (✓ takes 3), "bash" + '{"comm' 10 more: 25 bytes over two deltas.
        const micro = gatewayHangUpMicro(gw.chats()[0]!.body, 25, 2);
        expect(res).toMatchObject({ costUsd: micro / 1e6, costEstimatedUsd: micro / 1e6 });
      } else {
        expect(res.costUsd).toBeNull();
      }
    }
  });

  it("stops promptly when killed mid-stream, and the gateway sees the connection close at once (regression)", async () => {
    // The answer starts streaming, then the model keeps generating: a killed fork must hang up, not wait.
    const gw = await gateway(() => ({ body: null, sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "Let me look" })], hang: true }));
    const { cfg, ctl } = fork(gw.url);
    let killedAt = 0;
    setTimeout(() => {
      killedAt = performance.now();
      ctl.abort();
    }, 200);
    const res = await runHostedFork(cfg);
    expect(res.reason).toBe("killed");
    expect(performance.now() - killedAt).toBeLessThan(500);
    const closedAt = await gw.chats()[0]!.closed;
    expect(closedAt - killedAt).toBeLessThan(500);
  });

  it("gets through a cold start the gateway timed out after its headers went out: refunded in full, so the turn goes again", async () => {
    // The first turn's job sat in the GPU queue past the gateway's budget. By the retry a worker is warm.
    const coldStart: Reply = { body: null, sse: [": keep-alive\n\n", streamError("server_error", "upstream_timeout", "The hosted model did not finish within 280s.") + settled("0.000000")], hang: true };
    let turns = 0;
    const gw = await gateway(() => (++turns === 1 ? coldStart : reply({ content: "Nothing left to fix." }, "stop", "0.000100")));
    const { cfg } = fork(gw.url);
    const res = await runHostedFork(cfg);
    expect(res).toMatchObject({ reason: "end_turn", turns: 1, summary: "Nothing left to fix." });
    expect(res.costUsd).toBeCloseTo(0.0001, 10);
    expect(gw.chats()).toHaveLength(2);
  });

  it("maps a mid-stream error like the HTTP error it stands for, without retrying it", async () => {
    const cases: Array<[string, RegExp, boolean]> = [
      [streamError("server_error", "upstream_error", `The hosted model failed mid-stream (Bearer ${KEY}).`), /^hosted gateway error 502 upstream_error: The hosted model failed mid-stream \(Bearer \[redacted\]\)\.$/, false],
      [streamError("server_error", "upstream_timeout", "The hosted model did not finish within 280s."), /^hosted gateway error 504 upstream_timeout: The hosted model did not finish within 280s\.$/, false],
      [streamError("billing_error", "insufficient_credits", "Insufficient credits"), /^out of credit: burn \$FORKBOMB to top up at http:\/\/127\.0\.0\.1:\d+\/app \(Insufficient credits\)$/, true],
    ];
    for (const [event, want, outOfCredit] of cases) {
      const gw = await gateway(() => ({ body: null, sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "partial" }), event, settled("0.000010")], hang: true }));
      const { cfg, credit, bus } = fork(gw.url);
      const res = await runHostedFork(cfg);
      expect(res).toMatchObject({ reason: "error", turns: 1 });
      expect(res.error).toMatch(want);
      expect(JSON.stringify(bus.history)).not.toContain(KEY);
      expect(gw.chats()).toHaveLength(1);
      expect(credit.exhausted !== null).toBe(outOfCredit);
      // The failed call was still billed for what it generated, and the fork's cost says so.
      expect(res.costUsd).toBeCloseTo(0.00001, 10);
      // Reading stopped at the settlement: the connection is gone even though the server never closed it.
      await gw.chats()[0]!.closed;
    }
  });

  it("sums usage and reports cost as unknown when the gateway doesn't price a call", async () => {
    const script = [() => reply({ tool_calls: [call("bash", { command: "true" })] }), () => reply({ content: "done" }, "stop", null)];
    const gw = await gateway((c) => script[turnOf(c).turn]!());
    const res = await runHostedFork(fork(gw.url).cfg);
    expect(res).toMatchObject({ reason: "end_turn", inputTokens: 200, outputTokens: 40, costUsd: null });
  });

  it("redacts the key if a server ever echoes it back", async () => {
    const gw = await gateway(() => apiError(400, "bad_request", `bad header: Bearer ${KEY}`));
    const { cfg, bus } = fork(gw.url);
    const res = await runHostedFork(cfg);
    expect(res.error).toContain("[redacted]");
    expect(res.error).not.toContain(KEY);
    expect(JSON.stringify(bus.history)).not.toContain(KEY);
  });
});

describe("hosted engine: whole runs", () => {
  it("races hosted forks; the key never reaches a fork's shell, an event or the run log", async () => {
    process.env[HOSTED_KEY_ENV] = KEY;
    // The gateway's books: what it settled, and what it holds for a stream until that stream settles.
    let charged = 0;
    let held = 0;
    const gw = await gateway((c) => {
      if (c.path.endsWith("/me")) return meReply(5_000_000 - charged - held);
      const { turn, strategy } = turnOf(c);
      // The other fork's first answer streams a little, then the model keeps going until someone hangs up.
      // When it does, the gateway bills the prompt and the 11 bytes of thought, a moment after the hang-up.
      if (strategy !== "surgeon") {
        held += 20_000;
        void c.closed.then(() =>
          setTimeout(() => {
            held -= 20_000;
            charged += gatewayHangUpMicro(c.body, "Thinking...".length, 1);
          }, 300),
        );
        return { body: null, sse: [chunk({ role: "assistant", content: "" }), chunk({ reasoning: "Thinking..." })], hang: true };
      }
      charged += 1500; // each scripted reply settles at 0.0015
      const script = [
        () => reply({ tool_calls: [call("bash", { command: "env" })] }),
        () => reply({ tool_calls: [fixSum(), fixMul()] }),
        () => reply({ content: "Fixed both." }),
      ];
      return script[turn]!();
    });
    const repo = tempDir("hosted-repo");
    writeTree(repo, REPO);
    const client = new HostedClient({ baseUrl: gw.url, apiKey: KEY, retryBaseMs: 1 });
    const runsDir = tempDir("hosted-runs");
    const bus = new EventBus(join(runsDir, "events.jsonl"));
    const res = await runRace(options(repo, client, { runsDir }), bus);

    expect(res.ok).toBe(true);
    expect(res.winner).toBe("1.01");
    const start = bus.history.find((e) => e.type === "run_start");
    expect(start).toMatchObject({ engine: "hosted", model: `hosted (127.0.0.1:${gw.port})` });
    expect(bus.history.filter((e) => e.type === "kill").map((e) => e.type === "kill" && e.fork)).toEqual(["1.02"]);
    // Killing 1.02 hung up its stream, which is what tells the gateway to stop the GPU.
    const slow = gw.chats().filter((c) => turnOf(c).strategy !== "surgeon");
    expect(slow).toHaveLength(1);
    // That hung-up turn was still billed, and the run says so (regression: it used to report only 0.0045).
    const hungUp = gatewayHangUpMicro(slow[0]!.body, "Thinking...".length, 1);
    expect(hungUp).toBeGreaterThan(500);
    const killed = bus.history.find((e) => e.type === "fork_done" && e.fork === "1.02");
    expect(killed).toMatchObject({ reason: "killed", costUsd: hungUp / 1e6, costEstimatedUsd: hungUp / 1e6 });
    // Once the gateway settled it, the balance confirmed the figure, so the total is exact, not an estimate.
    expect(res.costUsd).toBeCloseTo((4500 + hungUp) / 1e6, 10);
    expect(res.costUsd).toBeCloseTo(charged / 1e6, 10);
    expect(res.costApprox).toBe(false);
    const end = bus.history.find((e) => e.type === "run_end");
    expect(end).toMatchObject({ costUsd: res.costUsd });
    expect(end && "costApprox" in end).toBe(false);
    const open = new Promise((done) => setTimeout(() => done("still open"), 2000));
    expect(await Promise.race([slow[0]!.closed, open])).toEqual(expect.any(Number));

    // The fork ran `env` in its sandbox; the result went to the gateway without the key.
    const envResult = gw.chats().find((c) => turnOf(c).strategy === "surgeon" && turnOf(c).turn === 1)!.body.messages.at(-1)!;
    expect(envResult.role).toBe("tool");
    expect(envResult.content).toContain("TMPDIR=");
    expect(envResult.content).not.toContain(KEY);
    expect(envResult.content).not.toContain(HOSTED_KEY_ENV);

    expect(JSON.stringify(bus.history)).not.toContain(KEY);
    expect(readFileSync(join(runsDir, "events.jsonl"), "utf8")).not.toContain(KEY);
  });

  it("stops the race cleanly when the first fork hits 402", async () => {
    const gw = await gateway(() => apiError(402, "insufficient_credits", "Insufficient credits: balance $0.000000"));
    const repo = tempDir("hosted-repo");
    writeTree(repo, REPO);
    const client = new HostedClient({ baseUrl: gw.url, apiKey: KEY, retryBaseMs: 1 });
    const bus = new EventBus();
    const res = await runRace(options(repo, client, { forks: 3, rounds: 2, concurrency: 1 }), bus);

    expect(res.ok).toBe(false);
    // One paid call found the balance empty; nobody else asked.
    expect(gw.chats()).toHaveLength(1);
    const done = bus.history.filter((e) => e.type === "fork_done");
    expect(done).toHaveLength(3);
    for (const d of done) {
      expect(d).toMatchObject({ reason: "error" });
      expect(d.type === "fork_done" && d.error).toMatch(new RegExp(`^out of credit: burn \\$FORKBOMB to top up at http://127\\.0\\.0\\.1:${gw.port}/app`));
    }
    // No second round.
    expect(bus.history.filter((e) => e.type === "fork")).toHaveLength(1);
    const logs = bus.history.filter((e) => e.type === "log" && e.msg.startsWith("Hosted credit ran out"));
    expect(logs).toHaveLength(1);
    expect(bus.history.at(-1)?.type).toBe("run_end");
    expect(JSON.stringify(bus.history)).not.toContain(KEY);
  });
});

// ---------- the streaming client against a mocked fetch: exact chunk boundaries, aborts and failures ----------

/** A response body that hands out one piece per read. `then` decides what follows the last piece. */
function body(pieces: Array<string | Uint8Array>, then: "close" | "hang" | Error = "close") {
  const enc = new TextEncoder();
  const state = { reads: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const piece = pieces[state.reads++];
        if (piece !== undefined) return controller.enqueue(typeof piece === "string" ? enc.encode(piece) : piece);
        if (then === "hang") return new Promise<void>(() => {});
        if (then instanceof Error) return controller.error(then);
        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const sseResponse = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } });

/** Replaces fetch with answers in order (the last one repeats) and records what was sent. */
function mockFetch(...answers: Array<() => Response>) {
  const sent: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(url), init, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
      return answers[Math.min(sent.length, answers.length) - 1]!();
    }),
  );
  return sent;
}

const REQ: ChatRequest = { messages: [{ role: "user", content: "fix it" }], tools: HOSTED_TOOLS };
const client = (o: { requestTimeoutMs?: number; errorGraceMs?: number } = {}) =>
  new HostedClient({ baseUrl: "https://gateway.test/api/v1", apiKey: KEY, maxRetries: 2, retryBaseMs: 1, errorGraceMs: 50, ...o });

/** A whole turn as the gateway streams it: keep-alives, a thought, content, two tool calls interleaved, usage, cost, [DONE]. */
const TURN = [
  ": keep-alive\n\n",
  chunk({ role: "assistant", content: "" }),
  chunk({ reasoning: "Two bugs: sum and mul." }),
  chunk({ content: "Fixing both ✓ " }),
  chunk({ content: "now." }),
  chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "edit", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command": "view", ' } }] }),
  ": keep-alive\n\n",
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"command": "node --test"}' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"path": "/workspace/math.js"}' } }] }),
  chunk({}, "tool_calls"),
  usageChunk(340, 92),
  settled("0.000427", "4.999573"),
  "data: [DONE]\n\n",
].join("");

const TURN_RESULT = {
  completion: {
    id: "chatcmpl-1",
    model: "forkbomb-hosted",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Fixing both ✓ now.",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "edit", arguments: '{"command": "view", "path": "/workspace/math.js"}' } },
            { id: "call_b", type: "function", function: { name: "bash", arguments: '{"command": "node --test"}' } },
          ],
          reasoning_content: "Two bugs: sum and mul.",
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 340, completion_tokens: 92, total_tokens: 432 },
  },
  costUsd: 0.000427,
  remainingUsd: 4.999573,
};

/** `text` as bytes in pieces of `size`: small sizes cut lines, "data:", CRLF pairs and the 3-byte ✓ in half. */
function pieces(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

describe("hosted client: streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for a stream with usage, and assembles the turn at any chunk boundary, LF or CRLF", async () => {
    for (const text of [TURN, TURN.replaceAll("\n", "\r\n")]) {
      for (const size of [1, 2, 3, 7, 64, 100_000]) {
        const sent = mockFetch(() => sseResponse(body(pieces(text, size)).stream));
        const turn = await client().chat(REQ, new AbortController().signal);
        expect(turn, `size ${size}`).toEqual(TURN_RESULT);
        expect(sent).toHaveLength(1);
        expect(sent[0]!.url).toBe("https://gateway.test/api/v1/chat/completions");
        expect(sent[0]!.body).toMatchObject({ model: "hosted", tool_choice: "auto", stream: true, stream_options: { include_usage: true } });
        expect(sent[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, accept: "text/event-stream" });
      }
    }
  });

  it("aborts the request and the body read at once when the fork is killed mid-stream", async () => {
    const { stream, state } = body([chunk({ role: "assistant", content: "" }), chunk({ content: "Let me" })], "hang");
    const sent = mockFetch(() => sseResponse(stream));
    const ctl = new AbortController();
    const pending = client().chat(REQ, ctl.signal);
    pending.catch(() => {});
    // Both pieces read; the third read waits on a model that is still generating.
    await vi.waitFor(() => expect(state.reads).toBe(3));
    const t0 = performance.now();
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - t0).toBeLessThan(100);
    expect(sent[0]!.init.signal!.aborted).toBe(true);
    expect(state.cancelled).toBe(true);
  });

  it("returns at [DONE] and leaves the rest of the body to the server, so the connection can be reused", async () => {
    const { stream, state } = body([TURN], "hang");
    mockFetch(() => sseResponse(stream));
    expect(await client().chat(REQ, new AbortController().signal)).toEqual(TURN_RESULT);
    expect(state.cancelled).toBe(false);
  });

  it("retries a busy pool (503) before the stream starts, then streams", async () => {
    const busy = () =>
      Response.json(
        { error: { message: "The hosted GPU pool is at capacity. Retry shortly.", type: "server_error", code: "upstream_busy" } },
        { status: 503, headers: { "retry-after": "0" } },
      );
    const sent = mockFetch(busy, busy, () => sseResponse(body([TURN]).stream));
    expect(await client().chat(REQ, new AbortController().signal)).toEqual(TURN_RESULT);
    expect(sent).toHaveLength(3);
  });

  it("treats an answer cut off before finish_reason as a network error, even when the gateway ends it with [DONE], and never resends it", async () => {
    const cut = [chunk({ role: "assistant", content: "" }), chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "bash", arguments: '{"comm' } }] })];
    // The body just ends; or the gateway, whose upstream broke off mid-answer, still settles and sends [DONE].
    const endings: Array<[string[], number | null]> = [
      [cut, null],
      [[...cut, settled("0.000031"), "data: [DONE]\n\n"], 0.000031],
    ];
    for (const [pieces, costUsd] of endings) {
      const sent = mockFetch(() => sseResponse(body(pieces).stream));
      const err = await client().chat(REQ, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostedError);
      expect(err).toMatchObject({ kind: "network", message: "the hosted gateway stream ended before the answer was complete", costUsd });
      expect(sent).toHaveLength(1);
    }
  });

  it("retries a stream the gateway refunded in full before the model produced anything, like the HTTP 503/504 it stands for", async () => {
    // The gateway's headers went out to hold the connection; then the job, still queued, ran out of time, or the
    // pool was busy or warming up. The error event, then the settlement at zero.
    const timeout = streamError("server_error", "upstream_timeout", "The hosted model did not finish within 280s.");
    const refunded: string[][] = [
      [": keep-alive\n\n", timeout + settled("0.000000")],
      [": keep-alive\n\n", chunk({ role: "assistant", content: "" }), streamError("server_error", "upstream_error", "The hosted model failed mid-stream."), settled("0.000000"), "data: [DONE]\n\n"],
      [streamError("server_error", "upstream_busy", "The hosted GPU pool is at capacity."), settled("0.000000")],
    ];
    for (const pieces of refunded) {
      const sent = mockFetch(() => sseResponse(body(pieces).stream), () => sseResponse(body([TURN]).stream));
      expect(await client().chat(REQ, new AbortController().signal)).toEqual(TURN_RESULT);
      expect(sent).toHaveLength(2);
    }
    // Refunded every time: once the retries run out, the error it stands for, at no cost.
    const sent = mockFetch(() => sseResponse(body([": keep-alive\n\n", timeout + settled("0.000000")]).stream));
    const err = await client().chat(REQ, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect(err).toMatchObject({ kind: "http", status: 504, costUsd: 0, message: "hosted gateway error 504 upstream_timeout: The hosted model did not finish within 280s." });
    expect(sent).toHaveLength(3);
  });

  it("never resends a failed stream that produced something, was charged, went unsettled, or would not be retried as HTTP", async () => {
    const timeout = streamError("server_error", "upstream_timeout", "The hosted model did not finish within 280s.");
    const cases: Array<[string[], object]> = [
      [[chunk({ reasoning: "Let me" }), timeout + settled("0.000000")], { status: 504, costUsd: 0 }],
      [[timeout + settled("0.000012")], { status: 504, costUsd: 0.000012 }],
      [[timeout], { status: 504, costUsd: null }], // no settlement within the grace: what it cost is unknown
      [[streamError("invalid_request_error", "upstream_rejected", "The prompt is too long."), settled("0.000000")], { kind: "http", status: 400, costUsd: 0 }],
      [[streamError("billing_error", "insufficient_credits", "Insufficient credits"), settled("0.000000")], { kind: "credits", status: 402 }],
    ];
    for (const [pieces, want] of cases) {
      const sent = mockFetch(() => sseResponse(body(pieces, "hang").stream));
      const err = await client().chat(REQ, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostedError);
      expect(err).toMatchObject(want);
      expect(sent).toHaveLength(1);
    }
  });

  it("reports a body that breaks mid-stream as a network error, and never resends it", async () => {
    const reset = Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } });
    const sent = mockFetch(() => sseResponse(body([chunk({ role: "assistant", content: "" })], reset).stream));
    await expect(client().chat(REQ, new AbortController().signal)).rejects.toMatchObject({
      kind: "network",
      message: "the hosted gateway stream broke off (ECONNRESET)",
    });
    expect(sent).toHaveLength(1);
  });

  it("stops a stream that outlives the request ceiling", async () => {
    const { stream, state } = body([chunk({ role: "assistant", content: "" })], "hang");
    mockFetch(() => sseResponse(stream));
    await expect(client({ requestTimeoutMs: 100 }).chat(REQ, new AbortController().signal)).rejects.toMatchObject({
      kind: "network",
      message: expect.stringMatching(/^the hosted gateway didn't finish answering within/),
    });
    expect(state.cancelled).toBe(true);
  });

  it("maps mid-stream errors to the HTTP errors they stand for, and stops reading", async () => {
    const cases: Array<[string, object]> = [
      [streamError("server_error", "upstream_error", "The hosted model stream broke off."), { kind: "http", status: 502 }],
      [streamError("server_error", "upstream_busy", "The hosted GPU pool is at capacity."), { kind: "unavailable", status: 503, message: expect.stringMatching(/at capacity/) }],
      [streamError("billing_error", "insufficient_credits", "Insufficient credits"), { kind: "credits", status: 402 }],
      [streamError("rate_limit_error", "rate_limited", "slow down"), { kind: "rate", status: 429 }],
      [streamError("authentication_error", "invalid_api_key", "Invalid API key"), { kind: "auth", status: 401 }],
      [streamError("invalid_request_error", "upstream_rejected", "max_tokens is too large"), { kind: "http", status: 400 }],
    ];
    for (const [event, want] of cases) {
      const { stream, state } = body([chunk({ content: "partial" }), event], "hang");
      const sent = mockFetch(() => sseResponse(stream));
      const err = await client().chat(REQ, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostedError);
      expect(err).toMatchObject(want);
      expect(sent).toHaveLength(1);
      expect(state.cancelled).toBe(true);
    }
  });

  it("keeps what a call that failed mid-stream was still charged, and hangs up after a short grace without it", async () => {
    const failed = streamError("server_error", "upstream_timeout", "The hosted model did not finish within 280s.");
    // The gateway settles right after the error event: in the same write (a timeout) or a moment later (an upstream failure).
    for (const pieces of [[chunk({ content: "partial" }), failed + settled("0.014100")], [chunk({ content: "partial" }), failed, ": keep-alive\n\n", settled("0.014100")]]) {
      const { stream, state } = body(pieces, "hang");
      mockFetch(() => sseResponse(stream));
      const t0 = performance.now();
      const err = await client({ errorGraceMs: 5000 }).chat(REQ, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HostedError);
      expect(err).toMatchObject({ kind: "http", status: 504, costUsd: 0.0141 });
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(state.cancelled).toBe(true);
    }
    // No settlement: the cost stays unknown, and the read stops after the grace even though the server hangs.
    const { stream, state } = body([chunk({ content: "partial" }), failed], "hang");
    mockFetch(() => sseResponse(stream));
    const t0 = performance.now();
    const err = await client({ errorGraceMs: 100 }).chat(REQ, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "http", status: 504, costUsd: null });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(state.cancelled).toBe(true);
    // A kill during the grace is still a kill.
    const hung = body([chunk({ content: "partial" }), failed], "hang");
    mockFetch(() => sseResponse(hung.stream));
    const ctl = new AbortController();
    const pending = client({ errorGraceMs: 5000 }).chat(REQ, ctl.signal);
    pending.catch(() => {});
    await vi.waitFor(() => expect(hung.state.reads).toBe(3));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(hung.state.cancelled).toBe(true);
  });

  it("takes an answer that ends on finish_reason without [DONE], with cost and balance from the headers", async () => {
    mockFetch(() =>
      sseResponse(body([chunk({ content: "Done." }), chunk({}, "stop")]).stream, { "x-request-cost-usd": "0.002", "x-credits-remaining-usd": "1.5" }),
    );
    const turn = await client().chat(REQ, new AbortController().signal);
    expect(turn.completion.choices[0]).toMatchObject({ message: { content: "Done." }, finish_reason: "stop" });
    expect(turn).toMatchObject({ costUsd: 0.002, remainingUsd: 1.5 });
  });

  it("prefers the settled figures in the stream over the reservation-time headers", async () => {
    mockFetch(() => sseResponse(body([TURN]).stream, { "x-credits-remaining-usd": "4.990000" }));
    expect(await client().chat(REQ, new AbortController().signal)).toMatchObject({ costUsd: 0.000427, remainingUsd: 4.999573 });
  });

  it("still takes a whole JSON completion from a server that ignores stream: true", async () => {
    const r = reply({ content: "ok" });
    mockFetch(() => Response.json(r.body, { headers: r.headers }));
    const turn = await client().chat(REQ, new AbortController().signal);
    expect(turn.completion.choices[0]!.message.content).toBe("ok");
    expect(turn).toMatchObject({ costUsd: 0.0015, remainingUsd: null });
  });
});

describe("hosted run cost", () => {
  const balances = (...seq: number[]) => {
    let i = 0;
    return { label: "hosted (test)", topUpUrl: "", chat: () => Promise.reject(new Error("unused")), balance: async () => seq[Math.min(i++, seq.length - 1)]! };
  };

  it("waits for the hung-up turns to settle, then takes the balance drop as the charge", async () => {
    // 4500 settled + 3000 estimated. First read: a 20,000 hold still open. Second: settled at 3,012.
    const client = balances(5_000_000 - 4500 - 20_000, 5_000_000 - 4500 - 3012);
    expect(await chargedSince(client, 5_000_000, { usd: 0.0075, estimatedUsd: 0.003 }, { everyMs: 5 })).toBeCloseTo(0.007512, 10);
  });

  it("keeps the estimate when the balance doesn't add up: a top-up landed, or another client spent on the key", async () => {
    expect(await chargedSince(balances(5_100_000), 5_000_000, { usd: 0.0075, estimatedUsd: 0.003 }, { everyMs: 5 })).toBeNull();
    expect(await chargedSince(balances(4_000_000), 5_000_000, { usd: 0.0075, estimatedUsd: 0.003 }, { everyMs: 5, waitMs: 40 })).toBeNull();
    const broken = { ...balances(0), balance: () => Promise.reject(new Error("down")) };
    expect(await chargedSince(broken, 5_000_000, { usd: 0.0075, estimatedUsd: 0.003 }, { everyMs: 5 })).toBeNull();
  });
});

describe("hosted settings and credits", () => {
  it("reads the base URL and key from env names built from the brand", () => {
    expect(HOSTED_KEY_ENV).toBe("FORKBOMB_API_KEY");
    expect(HOSTED_URL_ENV).toBe("FORKBOMB_HOSTED_URL");
    expect(hostedSettings({})).toEqual({ baseUrl: DEFAULT_HOSTED_URL, apiKey: null });
    expect(hostedSettings({ FORKBOMB_HOSTED_URL: "", FORKBOMB_API_KEY: "  " })).toEqual({ baseUrl: DEFAULT_HOSTED_URL, apiKey: null });
    expect(DEFAULT_HOSTED_URL).toBe("https://forkbomb.fun/api/v1");
    expect(hostedSettings({ FORKBOMB_HOSTED_URL: " http://localhost:3000/api/v1 ", FORKBOMB_API_KEY: ` ${KEY} ` })).toEqual({
      baseUrl: "http://localhost:3000/api/v1",
      apiKey: KEY,
    });
  });

  it("only sends the key over https, or plain http to this machine", () => {
    expect(() => checkBaseUrl("http://example.com/api/v1")).toThrow(/https/);
    expect(() => checkBaseUrl("not a url")).toThrow(/valid URL/);
    expect(() => checkBaseUrl("https://user:pw@example.com/api/v1")).toThrow(/credentials/);
    expect(checkBaseUrl("http://127.0.0.1:9/api/v1").host).toBe("127.0.0.1:9");
    const c = new HostedClient({ baseUrl: "https://forkbomb.fun/api/v1/", apiKey: KEY });
    expect(c.topUpUrl).toBe("https://forkbomb.fun/app");
    expect(c.label).toBe("hosted (forkbomb.fun)");
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  const ME = {
    workspace: { id: "ws_abc123", label: "laptop", createdAt: "2026-10-05T00:00:00Z" },
    credits: { balanceMicroUsd: 12_345_678, balanceUsd: 12.345678 },
    pricing: { inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.4, model: "forkbomb-coder" },
  };

  it("reads the balance from GET /me", async () => {
    const gw = await gateway((c) => (c.path === "/api/v1/me" && c.auth === `Bearer ${KEY}` ? { body: ME } : apiError(401, "invalid_api_key", "no")));
    const client = new HostedClient({ baseUrl: gw.url, apiKey: KEY });
    const me = await client.me();
    expect(me).toEqual(ME);
    const text = formatCredits(me, client.topUpUrl);
    expect(text).toContain("workspace  laptop (ws_abc123)");
    expect(text).toContain("credit     $12.3457");
    expect(text).toContain("$0.60 / 1M input tokens · $2.40 / 1M output tokens · model forkbomb-coder");
    expect(text).toContain(`burn $FORKBOMB at http://127.0.0.1:${gw.port}/app`);
  });

  it("`forkbomb credits` prints balance and pricing, and never the key", async () => {
    const gw = await gateway((c) => (c.auth === `Bearer ${KEY}` ? { body: ME } : apiError(401, "invalid_api_key", "Invalid API key")));
    const cli = (key: string) =>
      new Promise<{ code: number | null; out: string }>((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "credits"], {
          env: { ...process.env, [HOME_ENV]: tempDir("hosted-home"), [HOSTED_URL_ENV]: gw.url, [HOSTED_KEY_ENV]: key },
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (out += d.toString()));
        child.on("close", (code) => done({ code, out }));
      });

    const ok = await cli(KEY);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("credit     $12.3457");
    expect(ok.out).toContain("model forkbomb-coder");
    expect(ok.out).not.toContain(KEY);

    const wrong = `${KEY}x`;
    const bad = await cli(wrong);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/rejected your API key/);
    expect(bad.out).not.toContain(wrong);
    expect(bad.out).not.toContain(KEY);
  });
});
