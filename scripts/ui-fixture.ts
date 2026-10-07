// Dev-only: drive the orchestrator with a scripted fake model to produce an
// events.jsonl for working on the UI without spending API credit.
// Never present this output as a real run.
import { join } from "node:path";
import { EventBus } from "../src/events.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { runRace } from "../src/orchestrator.js";
import { FakeModel, message, tempDir, text, toolUse, writeTree } from "../test/helpers.js";

const repo = tempDir("fixture-repo");
writeTree(repo, {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "math.js": "export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a + b;\n",
  "math.test.js":
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum, mul } from "./math.js";\n' +
    'test("sum", () => assert.equal(sum(2, 3), 5));\ntest("mul", () => assert.equal(mul(2, 3), 6));\n',
});
const ed = (o: string, n: string) => toolUse("str_replace_based_edit_tool", { command: "str_replace", path: "/workspace/math.js", old_str: o, new_str: n });
const view = toolUse("str_replace_based_edit_tool", { command: "view", path: "/workspace/math.js" });
const runTests = toolUse("bash", { command: "node --test 2>&1 | tail -4" });
const fixSum = ed("a - b", "a + b");
const fixMul = ed("mul = (a, b) => a + b", "mul = (a, b) => a * b");
const steps = (...b: ReturnType<typeof toolUse>[]) => b.map((x) => message([x], "tool_use"));

const model = new FakeModel(
  {
    surgeon: [...steps(view, fixSum, runTests), message([text("Fixed sum. mul still fails.")])],
    "root-cause": [...steps(view, toolUse("bash", { command: "grep -n mul *.js" })), message([text("Can't tell what mul should be.")])],
    "test-driven": [...steps(runTests, toolUse("str_replace_based_edit_tool", { command: "create", path: "/workspace/math.test.js", file_text: "// gone\n" })), message([text("Tests pass now.")])],
    rewriter: [...steps(view, runTests, runTests), message([text("Ran out of ideas.")])],
    skeptic: [...steps(view, fixSum, runTests, runTests), message([text("Fixed sum.")])],
    cartographer: [...steps(toolUse("bash", { command: "ls -la" }), view), message([text("Mapped the repo.")])],
    sprinter: [...steps(fixSum, runTests), message([text("Partial fix.")])],
    "spec-first": [...steps(view), message([text("Wrote a spec.")])],
    "*": [...steps(view, fixMul, runTests), message([text("Fixed mul on top of the sum fix.")])],
  },
  { surgeon: 900, "root-cause": 700, "test-driven": 500, rewriter: 1100, skeptic: 1000, cartographer: 800, sprinter: 600, "spec-first": 1200, bisector: 700, minimalist: 2500, tracer: 2600, contrarian: 2800 },
);

const runsDir = tempDir("fixture-runs");
const runId = "fixture";
const { mkdirSync } = await import("node:fs");
mkdirSync(join(runsDir, runId), { recursive: true });
const bus = new EventBus(join(runsDir, runId, "events.jsonl"));
const res = await runRace(
  {
    runId, repo, task: "Fix math.js so the test suite passes", testCmd: "node --test", forks: 8, rounds: 2, mode: "race", model,
    effort: "medium", maxTurns: 12, forkTimeoutMs: 60_000, bashTimeoutMs: 20_000, testTimeoutMs: 30_000, maxOutput: 10_000,
    network: false, sandbox: true, protect: DEFAULT_PROTECT, apply: false, keepForks: false, runsDir, concurrency: 8,
  },
  bus,
);
console.log(JSON.stringify({ ok: res.ok, winner: res.winner, events: join(res.runDir, "events.jsonl") }));
