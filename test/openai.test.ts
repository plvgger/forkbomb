import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent.js";
import { HOME_ENV } from "../src/brand.js";
import { type CreditGate, runChatFork } from "../src/engines/chat.js";
import { OPENAI_KEY_ENV, OPENAI_URL_ENV, OpenAIClient, checkServer, doctorOpenAI, hasModel, openaiSettings } from "../src/engines/openai.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { type RunOptions, runRace } from "../src/orchestrator.js";
import { Workspace } from "../src/tools.js";
import { Semaphore } from "../src/util.js";
import { tempDir, writeTree } from "./helpers.js";

const KEY = "sk-or-v1-T3stKeyAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const MODEL = "qwen2.5-coder:7b";

const REPO = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "math.js": "export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a + b;\n",
  "math.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, mul } from "./math.js";\n' +
    'test("sum", () => assert.equal(sum(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
};

// ---------- a scriptable OpenAI-compatible server on loopback, shaped like Ollama's /v1 ----------

interface Msg {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface Call {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; messages: Msg[]; tools?: Array<{ function: { name: string } }> } & Record<string, unknown>;
}
/** One model turn: what it says, the calls it makes, or a stream that never ends (a model still thinking). */
interface Turn {
  content?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  hang?: boolean;
}
interface ServerOptions {
  /** What GET /v1/models lists; null answers 404, like a server without that endpoint. */
  models?: string[] | null;
  /** The model's answer to each chat request. */
  turn?: (c: Call) => Turn;
  /** Answer a request that carries stream_options with a 400, like a server older than the option. */
  rejectStreamOptions?: boolean;
  /** Never send the usage chunk, like a server that ignores stream_options. */
  noUsage?: boolean;
  /** Answer like Ollama does for a model without a tool template. */
  noTools?: boolean;
  /** Only take this key. */
  key?: string;
  /** A 400 that echoes the Authorization header back. */
  echoAuth?: boolean;
}

const servers: Array<() => void> = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
  delete process.env[OPENAI_KEY_ENV];
});

const json = (status: number, body: unknown) => ({ status, body });

async function openaiServer(o: ServerOptions = {}) {
  const calls: Call[] = [];
  const models = o.models === undefined ? [MODEL, "llama3:latest"] : o.models;
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString()));
    req.on("end", () => {
      const call: Call = { method: req.method ?? "", path: (req.url ?? "").split("?")[0]!, headers: req.headers, body: raw ? JSON.parse(raw) : { messages: [] } };
      calls.push(call);
      const send = (r: { status: number; body: unknown }) => res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
      const error = (status: number, message: string, type = "api_error") => send(json(status, { error: { message, type, param: null, code: null } }));
      if (o.key && req.headers.authorization !== `Bearer ${o.key}`) return error(401, "Invalid API key", "invalid_request_error");
      if (call.method === "GET" && call.path === "/v1/models") {
        if (models === null) return res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
        return send(json(200, { object: "list", data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "library" })) }));
      }
      if (call.method !== "POST" || call.path !== "/v1/chat/completions") return res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
      const model = String(call.body.model);
      if (o.echoAuth) return error(400, `bad request: ${req.headers.authorization}`, "invalid_request_error");
      // As Ollama 0.19 answers both.
      if (models !== null && !models.includes(model)) return error(404, `model '${model}' not found`, "not_found_error");
      if (o.noTools && call.body.tools) return error(400, `registry.ollama.ai/library/${model} does not support tools`, "invalid_request_error");
      if (o.rejectStreamOptions && call.body.stream_options) return error(400, "Unrecognized request argument supplied: stream_options", "invalid_request_error");

      const t = o.turn?.(call) ?? { content: "Nothing to do." };
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: `chatcmpl-${seq}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "" }));
      if (t.hang) return; // still thinking, until the client hangs up
      if (t.content) res.write(chunk({ content: t.content }));
      // Ollama sends each tool call whole, in one chunk.
      (t.calls ?? []).forEach((c, index) => res.write(chunk({ tool_calls: [{ index, id: `call_${++seq}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })));
      res.write(chunk({}, t.calls?.length ? "tool_calls" : "stop"));
      const usage = (call.body.stream_options as { include_usage?: boolean } | undefined)?.include_usage && !o.noUsage;
      if (usage) res.write(`data: ${JSON.stringify({ id: `chatcmpl-${seq}`, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  servers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const chats = () => calls.filter((c) => c.path.endsWith("/chat/completions"));
  return { url: `http://127.0.0.1:${port}/v1`, port, calls, chats };
}

/** Which turn of the conversation this request is, and which strategy the fork was given. */
function turnOf(c: Call): { turn: number; strategy: string } {
  const user = String(c.body.messages.find((m) => m.role === "user")?.content ?? "");
  return { turn: c.body.messages.filter((m) => m.role === "assistant").length, strategy: /Your strategy \(([^)]+)\)/.exec(user)?.[1] ?? "" };
}

const fixSum = { name: "edit", args: { command: "str_replace", path: "/workspace/math.js", old_str: "a - b", new_str: "a + b" } };
const fixMul = { name: "edit", args: { command: "str_replace", path: "/workspace/math.js", old_str: "mul = (a, b) => a + b", new_str: "mul = (a, b) => a * b" } };
/** A model that fixes both bugs, runs the suite and says so. */
const FIXER: Turn[] = [
  { calls: [{ name: "edit", args: { command: "view", path: "/workspace/math.js" } }] },
  { content: "Fixing both.", calls: [fixSum, fixMul] },
  { calls: [{ name: "bash", args: { command: "node --test 2>&1 | tail -8" } }] },
  { content: "Fixed sum and mul." },
];

function fork(client: OpenAIClient, maxTurns = 10) {
  const root = tempDir("openai");
  writeTree(root, REPO);
  const workspace = new Workspace({ root, tmp: `${root}-tmp`, network: false, gitWrite: false }, { bashTimeoutMs: 20_000, maxOutput: 10_000 });
  const bus = new EventBus();
  const credit: CreditGate = { exhausted: null };
  const cfg = {
    id: "1.01",
    workspace,
    client,
    system: systemPrompt({ bashTimeoutS: 20, engine: "openai" }),
    prompt: "Task: make the tests pass\nTest command: node --test\n\nYour strategy (surgeon): go",
    maxTurns,
    signal: new AbortController().signal,
    abortReason: () => "killed" as const,
    bus,
    apiSlots: new Semaphore(4),
    credit,
  };
  return { root, bus, cfg };
}

const client = (url: string, o: { key?: string | null; model?: string; retries?: number } = {}) =>
  new OpenAIClient({ baseUrl: url, apiKey: o.key ?? null, model: o.model ?? MODEL, maxRetries: o.retries ?? 2, retryBaseMs: 1 });

function options(repo: string, openai: OpenAIClient, over: Partial<RunOptions> = {}): RunOptions {
  return {
    runId: `o${Math.floor(performance.now() * 1000)}`,
    repo,
    task: "make the tests pass",
    testCmd: "node --test",
    forks: 2,
    rounds: 1,
    mode: "race",
    openai,
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
    runsDir: tempDir("openai-runs"),
    concurrency: 8,
    ...over,
  };
}

/** The CLI from source, with no OpenAI settings from this machine's environment. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      env: { ...process.env, [OPENAI_URL_ENV]: "", [OPENAI_KEY_ENV]: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => done({ code, out }));
  });
}

// ---------- tests ----------

describe("openai engine: one fork", () => {
  it("streams turns from the server, runs the tool calls in its clone, sums usage, and calls the cost unknown", async () => {
    const srv = await openaiServer({ turn: (c) => FIXER[turnOf(c).turn]! });
    const { root, bus, cfg } = fork(client(srv.url));
    const res = await runChatFork(cfg);

    expect(res).toMatchObject({ reason: "end_turn", turns: 4, inputTokens: 400, outputTokens: 80, costUsd: null, summary: "Fixed sum and mul." });
    expect(readFileSync(join(root, "math.js"), "utf8")).toBe("export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
    const chats = srv.chats();
    expect(chats).toHaveLength(4);
    const first = chats[0]!;
    expect(first.body).toMatchObject({ model: MODEL, stream: true, stream_options: { include_usage: true }, tool_choice: "auto" });
    expect(first.body.tools?.map((t) => t.function.name)).toEqual(["bash", "edit"]);
    expect(first.body.messages[0]!.content).toContain("Give it paths under /workspace");
    expect(first.headers.accept).toBe("text/event-stream");
    // No key set: no Authorization header at all.
    for (const c of srv.calls) expect(c.headers.authorization).toBeUndefined();
    expect(chats[3]!.body.messages.at(-1)!.content).toMatch(/pass 2\b/);
    expect(bus.history.filter((e) => e.type === "tool").map((e) => e.type === "tool" && e.ok)).toEqual([true, true, true, true]);
  });

  it("asks for usage, and sends the turn again without stream_options, once, when the server turns the option down", async () => {
    const srv = await openaiServer({ rejectStreamOptions: true, turn: (c) => (turnOf(c).turn === 0 ? { calls: [{ name: "bash", args: { command: "true" } }] } : { content: "done" }) });
    const res = await runChatFork(fork(client(srv.url)).cfg);
    expect(res).toMatchObject({ reason: "end_turn", turns: 2, inputTokens: 0, outputTokens: 0 });
    // Turn 1 with the option (400), turn 1 again without it, turn 2 without it: the client remembers.
    expect(srv.chats().map((c) => "stream_options" in c.body)).toEqual([true, false, false]);
  });

  it("finishes on a server that ignores stream_options and never reports usage", async () => {
    const srv = await openaiServer({ noUsage: true, turn: () => ({ content: "done" }) });
    const res = await runChatFork(fork(client(srv.url)).cfg);
    expect(res).toMatchObject({ reason: "end_turn", turns: 1, inputTokens: 0, outputTokens: 0, costUsd: null });
  });

  it("stops at once on a model the server doesn't have, and says what to do", async () => {
    const srv = await openaiServer();
    const res = await runChatFork(fork(client(srv.url, { model: "qwen2.5-coder:14b" })).cfg);
    expect(res.reason).toBe("error");
    expect(res.fatal).toMatch(/^the server at 127\.0\.0\.1:\d+ has no model "qwen2\.5-coder:14b" \(model 'qwen2\.5-coder:14b' not found\)\./);
    expect(res.fatal).toContain("ollama pull qwen2.5-coder:14b");
    expect(srv.chats()).toHaveLength(1);
  });

  it("stops at once on a server or model without tool calling, and says what to do", async () => {
    const srv = await openaiServer({ noTools: true });
    const res = await runChatFork(fork(client(srv.url, { model: "llama3:latest" })).cfg);
    expect(res.reason).toBe("error");
    expect(res.fatal).toMatch(/can't do tool calls with llama3:latest \(registry\.ollama\.ai\/library\/llama3:latest does not support tools\)\. Forks need tool calling/);
    expect(res.fatal).toContain('one with the "tools" tag');
    expect(srv.chats()).toHaveLength(1);
  });

  it("points at the base URL when nothing there answers Chat Completions", async () => {
    const srv = await openaiServer();
    const res = await runChatFork(fork(client(srv.url.replace(/\/v1$/, ""))).cfg);
    expect(res.fatal).toMatch(/has no Chat Completions API at http:\/\/127\.0\.0\.1:\d+ \(404: 404 page not found\)\. Check the base URL: it usually ends in \/v1/);
  });

  it("reports a server that isn't running, after its retries", async () => {
    const srv = await openaiServer();
    for (const close of servers.splice(0)) close();
    const res = await runChatFork(fork(client(srv.url, { retries: 1 })).cfg);
    expect(res.reason).toBe("error");
    expect(res.error).toMatch(/^can't reach the server at 127\.0\.0\.1:\d+ \(ECONNREFUSED\)\. Check that it's running/);
  });

  it("sends the key to the server only, and redacts it if the server echoes it back", async () => {
    const srv = await openaiServer({ key: KEY, echoAuth: true });
    const { bus, cfg } = fork(client(srv.url, { key: KEY }));
    const res = await runChatFork(cfg);
    expect(srv.chats()[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(res.error).toContain("Bearer [redacted]");
    expect(res.error).not.toContain(KEY);
    expect(JSON.stringify(bus.history)).not.toContain(KEY);
    // A key the server turns down stops the run, and names the variable to fix.
    const strict = await openaiServer({ key: KEY });
    const wrong = await runChatFork(fork(client(strict.url, { key: `${KEY}x` })).cfg);
    expect(wrong.fatal).toMatch(/rejected the API key \(401: Invalid API key\)\. Check OPENAI_API_KEY\.$/);
    const none = await runChatFork(fork(client(strict.url)).cfg);
    expect(none.fatal).toMatch(/wants an API key \(401: Invalid API key\)\. Set OPENAI_API_KEY\.$/);
  });
});

describe("openai engine: whole runs", () => {
  it("races forks on the server; the key reaches only the server, never a fork's shell, an event or the run log", async () => {
    process.env[OPENAI_KEY_ENV] = KEY;
    const srv = await openaiServer({
      key: KEY,
      turn: (c) => {
        const { turn, strategy } = turnOf(c);
        // The other fork is still thinking when 1.01 wins.
        if (strategy !== "surgeon") return { hang: true };
        return [{ calls: [{ name: "bash", args: { command: "env" } }] }, { calls: [fixSum, fixMul] }, { content: "Fixed both." }][turn]!;
      },
    });
    const repo = tempDir("openai-repo");
    writeTree(repo, REPO);
    const runsDir = tempDir("openai-runs");
    const bus = new EventBus(join(runsDir, "events.jsonl"));
    const res = await runRace(options(repo, client(srv.url, { key: KEY }), { runsDir }), bus);

    expect(res).toMatchObject({ ok: true, winner: "1.01", costUsd: null });
    expect(bus.history.find((e) => e.type === "run_start")).toMatchObject({ engine: "openai", model: `${MODEL} at 127.0.0.1:${srv.port}` });
    expect(bus.history.filter((e) => e.type === "kill").map((e) => e.type === "kill" && e.fork)).toEqual(["1.02"]);
    for (const e of bus.history) if (e.type === "fork_done") expect(e.costUsd).toBeNull();
    expect(bus.history.find((e) => e.type === "run_end")).toMatchObject({ ok: true, costUsd: null });
    for (const c of srv.calls) expect(c.headers.authorization).toBe(`Bearer ${KEY}`);

    // The fork ran `env` in its sandbox; the result went to the server without the key.
    const envResult = srv.chats().find((c) => turnOf(c).strategy === "surgeon" && turnOf(c).turn === 1)!.body.messages.at(-1)!;
    expect(envResult.role).toBe("tool");
    expect(envResult.content).toContain("TMPDIR=");
    expect(envResult.content).not.toContain(KEY);
    expect(envResult.content).not.toContain(OPENAI_KEY_ENV);
    expect(JSON.stringify(bus.history)).not.toContain(KEY);
    expect(readFileSync(join(runsDir, "events.jsonl"), "utf8")).not.toContain(KEY);
  });

  it("stops every fork at the first missing-model error, with one message for the run", async () => {
    // runRace does no preflight (the CLI does), so the first chat is what finds out.
    const srv = await openaiServer({ models: [MODEL] });
    const repo = tempDir("openai-repo");
    writeTree(repo, REPO);
    const bus = new EventBus();
    const res = await runRace(options(repo, client(srv.url, { model: "qwen2.5-coder:14b" }), { forks: 3, concurrency: 1 }), bus);
    expect(res).toMatchObject({ ok: false, error: "stopped", costUsd: null });
    expect(srv.chats()).toHaveLength(1);
    const errors = bus.history.filter((e) => e.type === "log" && e.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type === "log" && errors[0]!.msg).toMatch(/has no model "qwen2\.5-coder:14b"/);
    expect(bus.history.filter((e) => e.type === "kill")).toHaveLength(2);
  });
});

describe("openai settings and preflight", () => {
  it("takes --base-url over OPENAI_BASE_URL, and the key from OPENAI_API_KEY", () => {
    expect(OPENAI_URL_ENV).toBe("OPENAI_BASE_URL");
    expect(OPENAI_KEY_ENV).toBe("OPENAI_API_KEY");
    expect(openaiSettings(undefined, {})).toEqual({ baseUrl: null, urlSetting: "OPENAI_BASE_URL", apiKey: null });
    expect(openaiSettings(" ", { OPENAI_BASE_URL: " ", OPENAI_API_KEY: "" })).toEqual({ baseUrl: null, urlSetting: "OPENAI_BASE_URL", apiKey: null });
    const env = { OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_API_KEY: ` ${KEY} ` };
    expect(openaiSettings(undefined, env)).toEqual({ baseUrl: "https://openrouter.ai/api/v1", urlSetting: "OPENAI_BASE_URL", apiKey: KEY });
    expect(openaiSettings("http://localhost:11434/v1", env)).toEqual({ baseUrl: "http://localhost:11434/v1", urlSetting: "--base-url", apiKey: KEY });
  });

  it("refuses plain http to anything but this machine, and credentials in the URL", () => {
    const make = (baseUrl: string, urlSetting?: string) => new OpenAIClient({ baseUrl, apiKey: KEY, model: MODEL, ...(urlSetting ? { urlSetting } : {}) });
    expect(() => make("http://192.168.1.10:11434/v1", "--base-url")).toThrow("--base-url must use https (plain http is allowed only for localhost): http://192.168.1.10:11434/v1");
    expect(() => make("http://ollama.example.com/v1")).toThrow(/^OPENAI_BASE_URL must use https/);
    expect(() => make("https://user:pw@openrouter.ai/api/v1")).toThrow(/must not carry credentials/);
    expect(() => make("localhost:11434")).toThrow(/OPENAI_BASE_URL (is not a valid URL|must use https)/);
    for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8000/v1", "https://openrouter.ai/api/v1/"]) {
      const c = make(ok);
      expect(c.baseUrl).toBe(ok.replace(/\/$/, ""));
      expect(JSON.stringify(c)).not.toContain(KEY);
    }
    expect(make("https://openrouter.ai/api/v1").label).toBe(`${MODEL} at openrouter.ai`);
  });

  it("matches the model ids a server lists, with Ollama's :latest and variant suffixes", () => {
    const ids = ["llama3:latest", "qwen2.5-coder:7b", "qwen/qwen3-coder"];
    expect(hasModel(ids, "qwen2.5-coder:7b")).toBe(true);
    expect(hasModel(ids, "llama3")).toBe(true);
    expect(hasModel(ids, "qwen/qwen3-coder:nitro")).toBe(true);
    expect(hasModel(ids, "qwen2.5-coder:14b")).toBe(false);
    expect(hasModel(ids, "qwen2.5-coder")).toBe(false);
    expect(hasModel([], "llama3")).toBe(false);
  });

  it("checks the server, the key and the model once, without retries, before any fork starts", async () => {
    const srv = await openaiServer({ models: ["llama3:latest", MODEL] });
    expect(await checkServer(client(srv.url), AbortSignal.timeout(5000))).toBeNull();
    expect(await checkServer(client(srv.url, { model: "llama3" }), AbortSignal.timeout(5000))).toBeNull();
    await expect(checkServer(client(srv.url, { model: "qwen2.5-coder:14b" }), AbortSignal.timeout(5000))).rejects.toThrow(
      `the server at 127.0.0.1:${srv.port} has no model "qwen2.5-coder:14b". It lists llama3:latest, ${MODEL}. Pass one it lists to --model; on Ollama, pull it first: ollama pull qwen2.5-coder:14b`,
    );
    const empty = await openaiServer({ models: [] });
    await expect(checkServer(client(empty.url), AbortSignal.timeout(5000))).rejects.toThrow(/It lists no models\./);
    const noList = await openaiServer({ models: null });
    expect(await checkServer(client(noList.url), AbortSignal.timeout(5000))).toMatch(/has no model list \(GET \/models\), so --model qwen2\.5-coder:7b wasn't checked/);
    const locked = await openaiServer({ key: KEY });
    await expect(checkServer(client(locked.url), AbortSignal.timeout(5000))).rejects.toThrow(/wants an API key/);

    const down = await openaiServer();
    servers.at(-1)!();
    const t0 = performance.now();
    await expect(checkServer(client(down.url, { retries: 4 }), AbortSignal.timeout(5000))).rejects.toThrow(/can't reach the server at 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("`run --engine openai` checks its flags and the server before it makes a run folder", async () => {
    const home = tempDir("openai-home");
    const repo = tempDir("openai-cli-repo");
    writeTree(repo, REPO);
    const srv = await openaiServer({ models: ["llama3:latest"] });
    const closed = await openaiServer();
    servers.at(-1)!();
    const run = ["run", repo, "--task", "t", "--test", "node --test"];
    const cases: Array<[string[], NodeJS.ProcessEnv, string]> = [
      [["--engine", "openai", "--base-url", srv.url], {}, "--engine openai needs --model"],
      [["--engine", "api", "--base-url", srv.url], {}, "--base-url only applies to --engine openai"],
      [["--engine", "openai", "--model", MODEL], {}, "--engine openai needs a server: pass --base-url"],
      [["--engine", "openai", "--model", MODEL, "--base-url", "http://192.168.1.10:11434/v1"], {}, "--base-url must use https (plain http is allowed only for localhost)"],
      [["--engine", "openai", "--model", MODEL], { [OPENAI_URL_ENV]: "http://10.0.0.2:8000/v1" }, "OPENAI_BASE_URL must use https"],
      [["--engine", "openai", "--model", MODEL, "--base-url", closed.url], {}, `can't reach the server at 127.0.0.1:${closed.port} (ECONNREFUSED)`],
      [["--engine", "openai", "--model", MODEL, "--base-url", srv.url], {}, `has no model "${MODEL}". It lists llama3:latest.`],
    ];
    for (const [args, env, msg] of cases) {
      const r = await cli([...run, ...args], { [HOME_ENV]: home, ...env });
      expect(r.code, msg).toBe(1);
      expect(r.out, msg).toContain(msg);
    }
    // Only the last case reached this server, and only to ask for its model list.
    expect(srv.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/models"]);
    expect(existsSync(join(home, "runs"))).toBe(false);
  });

  it("doctor shows the openai engine's server, how many models it lists and whether a key is set, never the key", async () => {
    const srv = await openaiServer({ key: KEY });
    const ok = await doctorOpenAI(openaiSettings(undefined, { OPENAI_BASE_URL: srv.url, OPENAI_API_KEY: KEY }), AbortSignal.timeout(5000));
    expect(ok).toEqual({ level: "ok", text: `OpenAI-compatible server (engine: openai): ${srv.url} lists 2 models, with OPENAI_API_KEY` });
    const wrong = await doctorOpenAI(openaiSettings(undefined, { OPENAI_BASE_URL: srv.url, OPENAI_API_KEY: `${KEY}x` }), AbortSignal.timeout(5000));
    expect(wrong).toMatchObject({ level: "fail", hint: expect.stringMatching(/rejected the API key/) });
    expect(JSON.stringify(wrong)).not.toContain(KEY);
    expect(await doctorOpenAI(openaiSettings(undefined, {}), AbortSignal.timeout(5000))).toMatchObject({ level: "info", text: expect.stringMatching(/^No OpenAI-compatible server set \(OPENAI_BASE_URL\)/) });
    expect(await doctorOpenAI(openaiSettings(undefined, { OPENAI_BASE_URL: "http://192.168.1.10/v1" }), AbortSignal.timeout(5000))).toMatchObject({
      level: "fail",
      hint: expect.stringMatching(/OPENAI_BASE_URL must use https/),
    });
    servers.splice(0).forEach((close) => close());
    const down = await doctorOpenAI(openaiSettings(undefined, { OPENAI_BASE_URL: srv.url }), AbortSignal.timeout(5000));
    expect(down).toMatchObject({ level: "info", text: expect.stringMatching(new RegExp(`^OPENAI_BASE_URL is ${srv.url.replace(/[.]/g, "\\.")} \\(no OPENAI_API_KEY\\), but can't reach`)) });
  });
});
