import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_ENV } from "../src/brand.js";
import { cachedCanaryPass, runCanary } from "../src/engines/canary.js";
import { claudeEnv, claudeSettings, keyFiles, runClaudeCodeFork, shortVersion } from "../src/engines/claude-code.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { runRace } from "../src/orchestrator.js";
import { tempDir, writeTree } from "./helpers.js";

const FAKE = join(process.cwd(), "test", "fake-claude.mjs");

function setup(scripts: Record<string, unknown[]>) {
  const work = tempDir("cc");
  const scriptFile = join(work, "scripts.json");
  const log = join(work, "calls.jsonl");
  writeFileSync(scriptFile, JSON.stringify(scripts));
  // The engine hands claude an allowlisted env, so the stand-in gets its
  // config from a per-test wrapper instead of inherited variables.
  const bin = join(work, "claude");
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_SCRIPTS=${q(scriptFile)} FAKE_CLAUDE_LOG=${q(log)} exec ${q(process.execPath)} ${q(FAKE)} "$@"\n`);
  chmodSync(bin, 0o755);
  return { work, log, bin };
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function fork(dir: string, over: Partial<Parameters<typeof runClaudeCodeFork>[0]> = {}) {
  const bus = new EventBus();
  const ctl = new AbortController();
  const cfg = {
    id: "1.01",
    dir,
    tmp: `${dir}-tmp`,
    system: "sys",
    prompt: "Task: x\nYour strategy (surgeon): go",
    effort: "low",
    network: false,
    signal: ctl.signal,
    abortReason: () => "killed" as const,
    bus,
    claudeBin: FAKE,
    ...over,
  };
  return { cfg, bus, ctl };
}

describe("claude-code engine", () => {
  it("streams tool calls, returns the summary, and never hands the child an API key", async () => {
    const { work, log, bin } = setup({ surgeon: [{ write: { path: "a.txt", content: "hi" } }, { bash: "node --test" }, { text: "Fixed it." }] });
    process.env.ANTHROPIC_API_KEY = "sk-should-not-pass";
    const dir = join(work, "fork");
    writeTree(dir, { "README.md": "x" });
    const { cfg, bus } = fork(dir, { claudeBin: bin });
    const res = await runClaudeCodeFork(cfg, claudeSettings({ dir, tmp: cfg.tmp, network: false }));
    expect(res.reason).toBe("end_turn");
    expect(res.summary).toBe("Fixed it.");
    expect(res.costUsd).toBeNull();
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hi");
    const tools = bus.history.filter((e) => e.type === "tool");
    expect(tools.map((e) => e.type === "tool" && e.summary)).toEqual(["create /workspace/a.txt", "node --test"]);

    const call = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!);
    expect(call.apiKey).toBeNull();
    const argv: string[] = call.argv;
    expect(argv).toContain("--safe-mode");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(argv).not.toContain("--max-turns"); // unset: Claude Code's own default
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    expect(settings.permissions.deny).toContain("Read(~/.ssh/**)");
  });

  it("cuts a fork off when it's killed", async () => {
    const { work, bin } = setup({ surgeon: [{ sleep: 10_000 }, { text: "too late" }] });
    const dir = join(work, "fork");
    writeTree(dir, { "README.md": "x" });
    const { cfg, ctl } = fork(dir, { claudeBin: bin });
    setTimeout(() => ctl.abort(), 300);
    const t0 = performance.now();
    const res = await runClaudeCodeFork(cfg, {});
    expect(res.reason).toBe("killed");
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("passes --max-turns through to Claude Code (regression)", async () => {
    const { work, log, bin } = setup({ surgeon: [{ text: "ok" }] });
    const dir = join(work, "fork");
    writeTree(dir, { "README.md": "x" });
    await runClaudeCodeFork(fork(dir, { claudeBin: bin, maxTurns: 7 }).cfg, {});
    const argv: string[] = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!).argv;
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("7");
  });

  it("explains a login problem", async () => {
    const { work, bin } = setup({ surgeon: [{ error: "Failed to authenticate: OAuth session expired and could not be refreshed" }] });
    const dir = join(work, "fork");
    writeTree(dir, { "README.md": "x" });
    const res = await runClaudeCodeFork(fork(dir, { claudeBin: bin }).cfg, {});
    expect(res.reason).toBe("error");
    expect(res.error).toBe("Failed to authenticate: OAuth session expired and could not be refreshed. Run `claude auth login` with your Claude subscription.");
  });

  it("shows the version without repeating the product name", () => {
    expect(shortVersion("2.1.207 (Claude Code)")).toBe("2.1.207");
    expect(shortVersion("2.1.207")).toBe("2.1.207");
  });

  it("denies every key file kept in ~, a dot-folder in ~ or the CLI home", () => {
    const home = tempDir("cc-home");
    writeTree(home, {
      ".env": "A=1",
      ".forkbomb/admin.env": "B=1",
      ".forkbomb/runpod.env": "C=1",
      ".forkbomb/canary.json": "{}",
      ".othercli/.env": "D=1",
      "projects/app/.env": "E=1",
    });
    const cliHome = join(tempDir("cc-cli-home"), "home");
    writeTree(cliHome, { "hosted-test.env": "F=1", "runs/x/forks/1.01/.env": "G=1" });
    const keys = keyFiles(home, cliHome);
    expect(keys).toEqual(
      [
        join(home, ".env"),
        join(home, ".forkbomb/admin.env"),
        join(home, ".forkbomb/runpod.env"),
        join(home, ".othercli/.env"),
        join(cliHome, ".env"), // the CLI's own, listed before it exists
        join(cliHome, "hosted-test.env"),
      ].sort(),
    );

    const s = claudeSettings({ dir: "/w/fork", tmp: "/w/tmp", network: false, keys }) as {
      sandbox: { filesystem: { denyRead: string[] } };
      permissions: { deny: string[] };
    };
    for (const k of keys) {
      expect(s.sandbox.filesystem.denyRead).toContain(`/${k}`);
      expect(s.permissions.deny).toContain(`Read(/${k})`);
      expect(s.permissions.deny).toContain(`Edit(/${k})`);
    }
  });

  it("strips secrets from the child env", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.GITHUB_TOKEN_TEST = "y";
    process.env.CLAUDE_CODE_ENTRYPOINT = "z";
    const env = claudeEnv("/tmp/x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.HOME).toBe(process.env.HOME);
    delete process.env.GITHUB_TOKEN_TEST;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
  });

  it("runs a whole race on the Claude Code engine", async () => {
    const { work, bin } = setup({
      surgeon: [{ write: { path: "math.js", content: "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n" } }, { text: "Fixed both." }],
      "*": [{ sleep: 8000 }, { text: "slow" }],
    });
    const repo = join(work, "repo");
    writeTree(repo, {
      "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
      "math.js": "export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a + b;\n",
      "math.test.js":
        'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, mul } from "./math.js";\n' +
        'test("sum", () => assert.equal(sum(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
    });
    const bus = new EventBus();
    const res = await runRace(
      {
        runId: "cc1",
        repo,
        task: "fix",
        testCmd: "node --test",
        forks: 3,
        rounds: 1,
        mode: "race",
        claudeCode: { bin },
        effort: "low",
        maxTurns: 10,
        forkTimeoutMs: 30_000,
        bashTimeoutMs: 10_000,
        testTimeoutMs: 30_000,
        maxOutput: 10_000,
        network: false,
        sandbox: true,
        protect: DEFAULT_PROTECT,
        apply: false,
        keepForks: false,
        runsDir: tempDir("cc-runs"),
        concurrency: 8,
      },
      bus,
    );
    expect(res.ok).toBe(true);
    expect(res.winner).toBe("1.01");
    const start = bus.history.find((e) => e.type === "run_start");
    expect(start && start.type === "run_start" && start.engine).toBe("claude-code");
    expect(bus.history.filter((e) => e.type === "kill")).toHaveLength(2);
  });
});

describe("isolation canary", () => {
  const home = () => {
    const h = tempDir("canary-home");
    process.env[HOME_ENV] = h;
    return h;
  };
  const before = process.env[HOME_ENV];
  afterEach(() => {
    process.env[HOME_ENV] = before;
  });
  const denied = (name: string, input: Record<string, unknown>, result = "Operation not permitted") => ({ tool: { name, input, result, is_error: true } });
  const allSteps = [
    { write: { path: "inside.txt", content: "inside\n" } },
    denied("Bash", { command: "echo escaped > ../escape-bash.txt" }),
    denied("Write", { file_path: "/somewhere/escape-write.txt", content: "escaped" }, "Claude requested permissions to write, but you haven't granted it yet."),
    { tool: { name: "Bash", input: { command: "curl -sS -m 8 https://example.com -o /dev/null && echo NET_OPEN || echo NET_BLOCKED" }, result: "curl: (6) Could not resolve host: example.com\nNET_BLOCKED" } },
    denied("Bash", { command: "cat /somewhere/vault/secret.txt" }),
    denied("Read", { file_path: "/somewhere/vault/secret.txt" }, "Permission to read /somewhere/vault/secret.txt has been denied."),
    denied("Bash", { command: "echo x >> .git-probe && mkdir -p .git && echo pwned > .git/forkbomb-probe" }),
    { text: "DONE" },
  ];

  it("passes, and is cached, when every escape step was tried and failed", async () => {
    const h = home();
    const { bin } = setup({ "*": allSteps });
    const c = await runCanary({ bin });
    expect(c.error).toBeUndefined();
    expect(c.ok).toBe(true);
    expect(cachedCanaryPass(c.version)).toBe(true);
    expect(existsSync(join(h, "canary.json"))).toBe(true);
  });

  it("won't vouch for isolation it never tested: a session that skips the escape steps is inconclusive and not cached (regression)", async () => {
    const h = home();
    const { bin } = setup({ "*": [allSteps[0], { text: "I won't attempt the remaining escape steps." }] });
    const c = await runCanary({ bin });
    expect(c.ok).toBe(false);
    expect(c.inconclusive).toBe(true);
    expect(c.error).toMatch(/^inconclusive: the session didn't attempt steps 2 \(shell write outside the clone\), 3 .*7 \(write into \.git\)/);
    expect(c.checks.map((k) => k.ok)).toEqual([false, false, false, false, false, false]);
    expect(existsSync(join(h, "canary.json"))).toBe(false);
    expect(cachedCanaryPass(c.version)).toBe(false);

    // Skipping only one step is just as inconclusive.
    const { bin: one } = setup({ "*": allSteps.filter((_, i) => i !== 3) });
    const d = await runCanary({ bin: one });
    expect(d).toMatchObject({ ok: false, inconclusive: true });
    expect(d.error).toMatch(/didn't attempt step 4 \(outbound network\)/);
  });
});
