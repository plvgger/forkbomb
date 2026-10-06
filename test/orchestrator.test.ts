import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus, type Stamped } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { type RunOptions, runForkbomb } from "../src/orchestrator.js";
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
    heads: 3,
    rounds: 1,
    mode: "race",
    model,
    effort: "medium",
    maxTurns: 10,
    headTimeoutMs: 30_000,
    bashTimeoutMs: 20_000,
    testTimeoutMs: 30_000,
    maxOutput: 10_000,
    network: false,
    sandbox: true,
    protect: DEFAULT_PROTECT,
    apply: false,
    keepHeads: false,
    runsDir: tempDir("runs"),
    concurrency: 8,
    ...over,
  };
}

function collect(): { bus: EventBus; events: Stamped[] } {
  const bus = new EventBus();
  return { bus, events: bus.history };
}

describe("runForkbomb", () => {
  it("races heads: first real pass wins, cheaters get reverted, slow heads get cut, patch applies", async () => {
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
    const res = await runForkbomb(options(repo, model, { apply: true }), bus);

    expect(res.ok).toBe(true);
    expect(res.winner).toBe("1.01");
    expect(res.applied).toBe(true);
    expect(readFileSync(join(repo, "math.js"), "utf8")).toBe("export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
    expect(readFileSync(join(repo, "math.test.js"), "utf8")).toBe(REPO["math.test.js"]);

    const fork = events.find((e) => e.type === "fork");
    expect(fork && fork.type === "fork" && fork.heads).toEqual(["1.01", "1.02", "1.03"]);
    const cheat = events.find((e) => e.type === "judge" && e.head === "1.02");
    expect(cheat && cheat.type === "judge" && cheat.tampered).toEqual(["math.test.js"]);
    expect(cheat && cheat.type === "judge" && cheat.score).toBeLessThan(1);
    expect(events.some((e) => e.type === "sever" && e.head === "1.03")).toBe(true);
    const winner = events.find((e) => e.type === "winner");
    expect(winner && winner.type === "winner" && winner.patch).toContain("+export const mul = (a, b) => a * b;");
    expect(events.at(-1)?.type).toBe("run_end");

    // Losing heads are cleaned up; the winner and the body stay for inspection.
    expect(existsSync(join(res.runDir, "heads", "1.03"))).toBe(false);
    expect(existsSync(join(res.runDir, "heads", "1.01"))).toBe(true);
  });

  it("carries the best partial head into the next round", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const model = new FakeModel({
      surgeon: [message([fixSum], "tool_use"), message([text("Fixed sum; mul still broken.")])],
      "root-cause": [message([text("Not sure.")])],
      "*": [message([fixMul], "tool_use"), message([text("Fixed mul on top of the sum fix.")])],
    });
    const { bus, events } = collect();
    const res = await runForkbomb(options(repo, model, { heads: 2, rounds: 2 }), bus);

    expect(res.ok).toBe(true);
    expect(res.winner?.startsWith("2.")).toBe(true);
    const forks = events.filter((e) => e.type === "fork");
    expect(forks).toHaveLength(2);
    expect(forks[1]?.type === "fork" && forks[1].parent).toBe("1.01");
    const r2 = events.find((e) => e.type === "head_start" && e.round === 2);
    expect(r2 && r2.type === "head_start" && r2.parent).toBe("1.01");
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
    const res = await runForkbomb(options(repo, model, { heads: 2, mode: "best" }), bus);
    expect(res.winner).toBe("1.02");
    expect(events.some((e) => e.type === "sever")).toBe(false);
  });

  it("stops early when the suite already passes", async () => {
    const repo = tempDir("repo");
    writeTree(repo, { ...REPO, "math.js": "export const sum = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n" });
    const { bus, events } = collect();
    const res = await runForkbomb(options(repo, new FakeModel({})), bus);
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.type === "fork")).toBe(false);
  });

  it("reports a head that times out and still judges what it left", async () => {
    const repo = tempDir("repo");
    writeTree(repo, REPO);
    const model = new FakeModel({ "*": [message([fixSum], "tool_use"), message([toolUse("bash", { command: "sleep 20" })], "tool_use")] });
    const { bus, events } = collect();
    const res = await runForkbomb(options(repo, model, { heads: 1, headTimeoutMs: 1500 }), bus);
    expect(res.ok).toBe(false);
    const done = events.find((e) => e.type === "head_done");
    expect(done && done.type === "head_done" && done.reason).toBe("timeout");
    const j = events.find((e) => e.type === "judge");
    expect(j && j.type === "judge" && j.passed).toBe(1);
  });
});
