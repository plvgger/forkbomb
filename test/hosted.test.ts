import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent.js";
import { DEFAULT_HOSTED_URL, HOME_ENV, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "../src/brand.js";
import {
  type ChatCompletion,
  type CreditGate,
  HostedClient,
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
}
interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
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
      };
      calls.push(call);
      const r = await handler(call);
      if (r.delayMs) await new Promise((d) => setTimeout(d, r.delayMs));
      if (res.destroyed) return;
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
    expect(chats[0]!.body.model).toBe("hosted");
    expect(chats[0]!.body.stream).toBe(false);
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
    const gw = await gateway((c) => {
      const { turn, strategy } = turnOf(c);
      if (strategy !== "surgeon") return { ...reply({ content: "slow" }), delayMs: 8000 };
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
    expect(res.costUsd).toBeCloseTo(0.0045, 10);

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
