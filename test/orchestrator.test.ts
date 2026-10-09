import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelClient } from "../src/agent.js";
import { EventBus, type Stamped } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { type RunOptions, runRace } from "../src/orchestrator.js";
import { liveGroups } from "../src/procs.js";
import { FakeModel, message, tempDir, text, toolUse, writeTree } from "./helpers.js";

const REPO = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "math.js": "export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a + b;\n",
  "math.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, mul } from "./math.js";\n' +
    'test("sum", () => assert.equal(sum(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
};

const fixSum = toolUse("str_replace_based_edit_tool", { command: "str_replace", path: "/workspace/math.js", old_str: "a - b", new_str: "a + b" });
const fixMul = toolUse("str_replace_based_edit_tool", { command: "str_replace", path: "/workspace/math.js", old_str: "mul = (a, b) => a + b", new_str: "mul = (a, b) => a * b" });

function options(repo: string, model: FakeModel, over: Partial<RunOptions> = {}): RunOptions {
  return {
    runId: `t${Math.floor(performance.now() * 1000)}`,
    repo,
    task: "make the tests pass",
    testCmd: "node --test",
    forks: 3,
    rounds: 1,
    mode: "race",
    model,
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
    runsDir: tempDir("runs"),
    concurrency: 8,
    ...over,
  };
}

function collect(): { bus: EventBus; events: Stamped[] } {
  const bus = new EventBus();
  return { bus, events: bus.history };
}

describe("runRace", () => {
  it("races forks: first real pass wins, cheaters get reverted, slow forks get cut, patch applies", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const model = new FakeModel(
      {
        // 1.01 fixes both functions properly.
        surgeon: [
          message([fixSum], "tool_use"),
          message([toolUse("str_replace_based_edit_tool", { command: "str_replace", path: "math.js", old_str: "mul = (a, b) => a + b", new_str: "mul = (a, b) => a * b" })], "tool_use"),
          message([toolUse("bash", { command: "node --test 2>&1 | tail -3" })], "tool_use"),
          message([text("Fixed sum and mul.")]),
        ],
        // 1.02 rewrites the tests to always pass.
        "root-cause": [
          message([toolUse("str_replace_based_edit_tool", { command: "create", path: "/workspace/math.test.js", file_text: 'import { test } from "node:test";\ntest("sum", () => {});\ntest("mul", () => {});\n' })], "tool_use"),
          message([text("All green.")]),
        ],
        // 1.03 is slow and never finishes in time.
        "test-driven": [message([toolUse("bash", { command: "echo thinking" })], "tool_use"), message([toolUse("bash", { command: "echo still" })], "tool_use")],
      },
      { surgeon: 30, "root-cause": 10, "test-driven": 4000 },
    );
    const { bus, events } = collect();
    const res = await runRace(options(repo, model, { apply: true }), bus);

    expect(res.ok).toBe(true);
    expect(res.winner).toBe("1.01");
    expect(res.applied).toBe(true);
    expect(readFileSync(join(repo, "math.js"), "utf8")).toBe("export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
    expect(readFileSync(join(repo, "math.test.js"), "utf8")).toBe(REPO["math.test.js"]);

    const fork = events.find((e) => e.type === "fork");
    expect(fork && fork.type === "fork" && fork.forks).toEqual(["1.01", "1.02", "1.03"]);
    const cheat = events.find((e) => e.type === "judge" && e.fork === "1.02");
    expect(cheat && cheat.type === "judge" && cheat.tampered).toEqual(["math.test.js"]);
    expect(cheat && cheat.type === "judge" && cheat.score).toBeLessThan(1);
    expect(events.some((e) => e.type === "kill" && e.fork === "1.03")).toBe(true);
    const winner = events.find((e) => e.type === "winner");
    expect(winner && winner.type === "winner" && winner.patch).toContain("+export const mul = (a, b) => a * b;");
    expect(events.at(-1)?.type).toBe("run_end");

    // Losing forks are cleaned up; the winner and the body stay for inspection.
    expect(existsSync(join(res.runDir, "forks", "1.03"))).toBe(false);
    expect(existsSync(join(res.runDir, "forks", "1.01"))).toBe(true);
  });

  it("carries the best partial fork into the next round", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const model = new FakeModel({
      surgeon: [message([fixSum], "tool_use"), message([text("Fixed sum; mul still broken.")])],
      "root-cause": [message([text("Not sure.")])],
      "*": [message([fixMul], "tool_use"), message([text("Fixed mul on top of the sum fix.")])],
    });
    const { bus, events } = collect();
    const res = await runRace(options(repo, model, { forks: 2, rounds: 2 }), bus);

    expect(res.ok).toBe(true);
    expect(res.winner?.startsWith("2.")).toBe(true);
    const forks = events.filter((e) => e.type === "fork");
    expect(forks).toHaveLength(2);
    expect(forks[1]?.type === "fork" && forks[1].parent).toBe("1.01");
    const r2 = events.find((e) => e.type === "fork_start" && e.round === 2);
    expect(r2 && r2.type === "fork_start" && r2.parent).toBe("1.01");
    // The user's repo is untouched without --apply.
    expect(readFileSync(join(repo, "math.js"), "utf8")).toBe(REPO["math.js"]);
    expect(res.patchPath && readFileSync(res.patchPath, "utf8")).toContain("a * b");
  });

  it("best mode waits for everyone and keeps the smallest passing diff", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const bloat = toolUse("str_replace_based_edit_tool", {
      command: "create",
      path: "/workspace/math.js",
      file_text: "// rewritten\n// with\n// lots\n// of\n// comments\nexport const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n",
    });
    const model = new FakeModel({
      surgeon: [message([bloat], "tool_use"), message([text("Rewrote it.")])],
      "root-cause": [message([fixSum, fixMul], "tool_use"), message([text("Two small fixes.")])],
    });
    const { bus, events } = collect();
    const res = await runRace(options(repo, model, { forks: 2, mode: "best" }), bus);
    expect(res.winner).toBe("1.02");
    expect(events.some((e) => e.type === "kill")).toBe(false);
  });

  it("stops early when the suite already passes", async () => {
    const repo = tempDir("repo");
    writeTree(repo, { ...REPO, "math.js": "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n" });
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({})), bus);
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.type === "fork")).toBe(false);
  });

  it("reports a fork that times out and still judges what it left", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const model = new FakeModel({ "*": [message([fixSum], "tool_use"), message([toolUse("bash", { command: "sleep 20" })], "tool_use")] });
    const { bus, events } = collect();
    const res = await runRace(options(repo, model, { forks: 1, forkTimeoutMs: 1500 }), bus);
    expect(res.ok).toBe(false);
    const done = events.find((e) => e.type === "fork_done");
    expect(done && done.type === "fork_done" && done.reason).toBe("timeout");
    const j = events.find((e) => e.type === "judge");
    expect(j && j.type === "judge" && j.passed).toBe(1);
  });

  it("doesn't fork at all when the test command itself can't run (regression)", async () => {
    for (const testCmd of ["nosuchtestcmd --run", "npm run tset"]) {
      const repo = tempDir("repo");
      writeTree(repo, REPO);
      let calls = 0;
      const model: ModelClient = { model: "fake", turn: async () => (calls++, message([text("x")])) };
      const { bus, events } = collect();
      const res = await runRace(options(repo, new FakeModel({}), { model, testCmd }), bus);
      expect(res.ok, testCmd).toBe(false);
      expect(res.error, `${testCmd}: ${JSON.stringify(events.filter((e) => e.type === "log" || e.type === "baseline"))}`).toMatch(/Check --test/);
      expect(calls, testCmd).toBe(0);
      expect(events.some((e) => e.type === "fork" || e.type === "fork_start"), testCmd).toBe(false);
      expect(events.some((e) => e.type === "log" && e.level === "error" && e.msg.startsWith("No forks started")), testCmd).toBe(true);
      expect(events.at(-1)?.type, testCmd).toBe("run_end");
    }
  });

  it("names no best fork, and saves no best.patch, when no fork beat the baseline (regression)", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    // Every fork changes something harmless: a patch, but the suite still fails as before.
    const noop = toolUse("str_replace_based_edit_tool", { command: "create", path: "/workspace/NOTES.md", file_text: "tried\n" });
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({ "*": [message([noop], "tool_use"), message([text("Could not fix it.")])] }), { forks: 2 }), bus);
    expect(res).toMatchObject({ ok: false, best: null, patchPath: null });
    expect(existsSync(join(res.runDir, "best.patch"))).toBe(false);
    const warn = events.find((e) => e.type === "log" && e.level === "warn");
    expect(warn && warn.type === "log" && warn.msg).toBe("No fork passed the whole suite or did better than the baseline (0/2 passing).");
  });

  it("stops every fork when the API rejects the key, instead of judging a run of failures (regression)", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    let calls = 0;
    const model: ModelClient = {
      model: "fake",
      turn: async (_req, signal) => {
        calls++;
        if (calls === 1) throw new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers());
        await new Promise((done) => signal.addEventListener("abort", done));
        throw new Error("aborted");
      },
    };
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({}), { model, forks: 3, rounds: 2 }), bus);
    expect(res.ok).toBe(false);
    expect(calls).toBe(3); // one round, and nobody asked twice
    expect(events.filter((e) => e.type === "fork")).toHaveLength(1);
    expect(events.some((e) => e.type === "judging")).toBe(false);
    const first = events.find((e) => e.type === "fork_done" && e.reason === "error");
    expect(first && first.type === "fork_done" && first.error).toMatch(/^API 401 \{/); // not "API 401 401"
    expect(events.some((e) => e.type === "log" && e.msg.includes("rejected the key (401)"))).toBe(true);
    expect(events.filter((e) => e.type === "kill")).toHaveLength(2);
  });

  it("stops cleanly when interrupted mid-race: forks and their commands killed, clones and temp files gone, run_end says so (regression)", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const hang = message([toolUse("bash", { command: "sleep 300 & sleep 300" })], "tool_use");
    const ctl = new AbortController();
    const { bus, events } = collect();
    bus.on((e) => {
      if (e.type === "tool" || (e.type === "fork_start" && e.fork === "1.03")) setTimeout(() => ctl.abort(), 400);
    });
    const t0 = performance.now();
    const res = await runRace(options(repo, new FakeModel({ "*": [hang, hang] }), { signal: ctl.signal, apply: true, rounds: 2 }), bus);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(res).toMatchObject({ ok: false, interrupted: true, applied: false });
    expect(liveGroups()).toBe(0);
    expect(events.filter((e) => e.type === "fork")).toHaveLength(1);
    expect(events.filter((e) => e.type === "kill").length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: "run_end", ok: false, interrupted: true });
    expect(readdirSync(join(res.runDir, "forks"))).toEqual([]);
    expect(existsSync(join(res.runDir, "tmp"))).toBe(false);
  });

  it("stops at once when interrupted during the baseline", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    const t0 = performance.now();
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({}), { signal: ctl.signal, testCmd: "sleep 60; node --test" }), bus);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(res).toMatchObject({ ok: false, interrupted: true });
    expect(liveGroups()).toBe(0);
    expect(events.some((e) => e.type === "fork")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_end", interrupted: true });
  });

  it("stops every fork before the disk fills up", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({ "*": [message([fixSum], "tool_use")] }), { diskFloorBytes: Number.MAX_SAFE_INTEGER }), bus);
    expect(res).toMatchObject({ ok: false, error: "disk nearly full" });
    expect(events.some((e) => e.type === "fork")).toBe(false);
    expect(events.some((e) => e.type === "log" && /left on the disk/.test(e.msg))).toBe(true);
  });

  it("keeps a fork from faking a pass through a script the test command runs (regression)", async () => {
    const repo = tempDir("repo");
    // The suite runs through a small runner script, which no protect glob names.
    writeTree(repo, {
      ...REPO,
      "runner.mjs": 'import { spawnSync } from "node:child_process";\nconst r = spawnSync("node", ["--test"], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n',
    });
    const fake = toolUse("str_replace_based_edit_tool", { command: "create", path: "/workspace/runner.mjs", file_text: 'console.log("# pass 2\\n# fail 0");\n' });
    const { bus, events } = collect();
    const res = await runRace(options(repo, new FakeModel({ "*": [message([fake], "tool_use"), message([text("All green.")])] }), { forks: 1, testCmd: "node runner.mjs" }), bus);
    expect(res.ok).toBe(false);
    expect(events.some((e) => e.type === "log" && e.msg.includes("Also read-only for forks") && e.msg.includes("runner.mjs"))).toBe(true);
    const j = events.find((e) => e.type === "judge");
    expect(j && j.type === "judge" && j.tampered).toEqual(["runner.mjs"]);
    expect(j && j.type === "judge" && j.score).toBeLessThan(1);
  });
});
