import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApfsForker } from "../src/fork/forker.js";
import { DEFAULT_PROTECT, brokenTestCommand, judge, parseCounts, score, testInfraFiles } from "../src/judge.js";
import { globToRegExp } from "../src/util.js";
import { tempDir, writeTree } from "./helpers.js";

describe("parseCounts", () => {
  const cases: Array<[string, string, number | null, number | null]> = [
    ["node:test spec", "ℹ tests 14\nℹ suites 0\nℹ pass 4\nℹ fail 10\n", 4, 10],
    ["node:test tap", "# tests 3\n# pass 3\n# fail 0\n", 3, 0],
    ["vitest mixed", " Test Files  1 failed (1)\n      Tests  2 failed | 9 passed (11)\n", 9, 2],
    ["vitest pass", "      Tests  12 passed (12)\n", 12, 0],
    ["jest", "Tests:       2 failed, 9 passed, 11 total\n", 9, 2],
    ["jest pass", "Tests:       11 passed, 11 total\n", 11, 0],
    ["pytest", "===== 2 failed, 9 passed in 0.12s =====\n", 9, 2],
    ["pytest errors", "==== 1 failed, 3 passed, 2 errors in 1.01s ====\n", 3, 3],
    ["pytest pass", "============ 9 passed in 0.05s ============\n", 9, 0],
    ["mocha", "  9 passing (20ms)\n  2 failing\n", 9, 2],
    ["unittest fail", "Ran 11 tests in 0.002s\n\nFAILED (failures=2, errors=1)\n", 8, 3],
    ["unittest ok", "Ran 11 tests in 0.002s\n\nOK\n", 11, 0],
    ["cargo", "test result: FAILED. 9 passed; 2 failed; 0 ignored\n", 9, 2],
    ["go", "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- PASS: TestC\n", 2, 1],
    ["unknown", "all good\n", null, null],
  ];
  for (const [name, out, p, f] of cases) {
    it(name, () => expect(parseCounts(out)).toEqual({ passed: p, failed: f }));
  }
});

describe("score", () => {
  it("full pass only with no missing tests", () => {
    expect(score(0, { passed: 14, failed: 0 }, 14)).toBe(1);
    expect(score(0, { passed: 3, failed: 0 }, 14)).toBeLessThan(0.3);
    expect(score(0, { passed: null, failed: null }, 14)).toBe(1);
  });
  it("partial credit stays below 1", () => {
    expect(score(1, { passed: 13, failed: 1 }, 14)).toBeCloseTo((0.99 * 13) / 14);
    expect(score(1, { passed: null, failed: null }, 14)).toBe(0);
  });
});

describe("protect globs", () => {
  const g = DEFAULT_PROTECT.map(globToRegExp);
  const hit = (p: string) => g.some((r) => r.test(p));
  it("covers test files and config", () => {
    for (const p of ["calc.test.js", "src/a.spec.ts", "tests/x.py", "pkg/test/helper.js", "test_x.py", "package.json", "web/package.json", "vitest.config.ts",
      "tsconfig.json", "tsconfig.build.json", "babel.config.js", ".babelrc", "vitest.setup.ts", "src/setupTests.ts", "jest.setup.js", ".npmrc", "sitecustomize.py"]) {
      expect(hit(p), p).toBe(true);
    }
  });
  it("leaves source alone", () => {
    for (const p of ["calc.js", "src/latest.ts", "contest.py", "src/testing-utils.js", "src/config.ts", "src/setup.ts"]) expect(hit(p), p).toBe(false);
  });
});

describe("testInfraFiles", () => {
  const tree = {
    "package.json": JSON.stringify({
      main: "index.js",
      exports: { require: "./lib/index.cjs" },
      scripts: { pretest: "node prep.mjs", test: "node scripts/run.mjs && npm run lint", lint: "node lint.mjs --config=lint.json", build: "node build.mjs" },
      jest: { setupFilesAfterEnv: ["<rootDir>/jest-after.js"] },
    }),
    "index.js": "",
    "lib/index.cjs": "",
    "prep.mjs": "",
    "scripts/run.mjs": "",
    "lint.mjs": "",
    "lint.json": "{}",
    "build.mjs": "",
    "jest-after.js": "",
    "vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { setupFiles: ["./vsetup.ts"], globalSetup: "./global.ts", include: ["src/**/*.test.ts"] } });\n',
    "vsetup.ts": "",
    "global.ts": "",
    ".mocharc.yml": "require: ./mocha-setup.js\nspec: test/**/*.js\n",
    "mocha-setup.js": "",
    "runner.mjs": "",
    "imp.mjs": "",
  };

  it("finds the scripts the test command runs and the setup files its config loads, and leaves source alone", async () => {
    const root = tempDir("infra");
    writeTree(root, tree);
    expect(await testInfraFiles(root, "npm test")).toEqual(
      ["global.ts", "jest-after.js", "lint.json", "lint.mjs", "mocha-setup.js", "prep.mjs", "scripts/run.mjs", "vsetup.ts"],
    );
    const direct = await testInfraFiles(root, "node --import ./imp.mjs runner.mjs 2>&1 | tail -20");
    expect(direct).toContain("runner.mjs");
    expect(direct).toContain("imp.mjs");
    expect(direct).not.toContain("prep.mjs"); // npm scripts only count when npm runs them
    for (const p of ["index.js", "lib/index.cjs", "build.mjs"]) expect(direct).not.toContain(p);
  });

  it("never reaches outside the repo", async () => {
    const root = tempDir("infra");
    writeTree(root, { "a.sh": "" });
    expect(await testInfraFiles(root, "bash a.sh /etc/hosts ../outside.sh")).toEqual(["a.sh"]);
  });
});

describe("brokenTestCommand", () => {
  const out = (o: Partial<{ code: number | null; output: string; timedOut: boolean }>) => ({ code: 1, output: "", timedOut: false, aborted: false, ms: 1, ...o });
  const none = { passed: null, failed: null };
  it("refuses a command that can't run, a missing npm script and a suite that never exits", () => {
    expect(brokenTestCommand(out({ code: 127, output: "/bin/bash: nosuchtestcmd: command not found" }), none, 300_000)).toMatch(/exit 127: command not found/);
    expect(brokenTestCommand(out({ code: 126 }), none, 300_000)).toMatch(/not executable/);
    expect(brokenTestCommand(out({ output: 'npm error Missing script: "tset"' }), none, 300_000)).toMatch(/script that doesn't exist/);
    expect(brokenTestCommand(out({ code: null, timedOut: true, output: "Tests  3 passed (3)\nwatching for changes" }), { passed: 3, failed: 0 }, 300_000)).toMatch(/didn't exit/);
  });
  it("lets a real failing suite through, and a hang that may be the bug itself", () => {
    expect(brokenTestCommand(out({ output: "ℹ pass 4\nℹ fail 10" }), { passed: 4, failed: 10 }, 300_000)).toBeNull();
    expect(brokenTestCommand(out({ output: "Error: ENOENT: no such file or directory, open 'fixture.json'" }), none, 300_000)).toBeNull();
    expect(brokenTestCommand(out({ code: null, timedOut: true, output: "running..." }), none, 300_000)).toBeNull();
  });
});

/** A body repo with a base commit, plus one fork cloned from it. */
async function bodyAndFork(files: Record<string, string>) {
  const body = tempDir("body");
  writeTree(body, files);
  const git = (...a: string[]) => execFileSync("git", ["-C", body, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).toString().trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const forker = await ApfsForker.create();
  const work = tempDir("work");
  const fork = join(work, "fork");
  await forker.fork(body, [fork]);
  return { body, fork, base, forker, work };
}

describe("judge", () => {
  const files = {
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
    "sum.js": 'import { helper } from "dep";\nexport const sum = (a, b) => helper(a - b);\n',
    "sum.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\n' +
      'test("adds", () => assert.equal(sum(2, 3), 5));\ntest("zero", () => assert.equal(sum(0, 0), 0));\n',
    ".gitignore": "node_modules\n",
    "node_modules/dep/package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
    "node_modules/dep/index.js": "export const helper = (x) => x;\n",
  };
  const run = async (ctx: Awaited<ReturnType<typeof bodyAndFork>>) =>
    judge(
      { root: ctx.fork, tmp: `${ctx.fork}-tmp`, network: false, gitWrite: false },
      {
        testCmd: "node --test",
        baseSha: ctx.base,
        protect: DEFAULT_PROTECT.map(globToRegExp),
        testTimeoutMs: 30_000,
        maxOutput: 10_000,
        baselineTotal: 2,
        bodyDir: ctx.body,
        forker: ctx.forker,
        stateDir: join(ctx.work, "state"),
        tmpDir: join(ctx.work, "tmp"),
        network: false,
        sandbox: true,
      },
    );

  it("scores a real fix and captures the patch", async () => {
    const ctx = await bodyAndFork(files);
    writeFileSync(join(ctx.fork, "sum.js"), 'import { helper } from "dep";\nexport const sum = (a, b) => helper(a + b);\n');
    writeFileSync(join(ctx.fork, "NOTES.md"), "new file\n");
    const v = await run(ctx);
    expect(v.score).toBe(1);
    expect(v.passed).toBe(2);
    expect(v.filesChanged).toBe(2);
    expect(v.patch).toContain("helper(a + b)");
    expect(v.patch).toContain("NOTES.md");
    expect(v.tampered).toEqual([]);
    expect(v.stateDir && readFileSync(join(v.stateDir, "sum.js"), "utf8")).toContain("a + b");
    // The body itself is never modified.
    expect(readFileSync(join(ctx.body, "sum.js"), "utf8")).toBe(files["sum.js"]);
  });

  it("drops edits to tests and planted test files from what gets judged", async () => {
    const ctx = await bodyAndFork(files);
    writeFileSync(join(ctx.fork, "sum.test.js"), 'import { test } from "node:test";\ntest("adds", () => {});\ntest("zero", () => {});\n');
    writeFileSync(join(ctx.fork, "extra.test.js"), 'import { test } from "node:test";\ntest("free", () => {});\n');
    const v = await run(ctx);
    expect(v.tampered.sort()).toEqual(["extra.test.js", "sum.test.js"]);
    expect(v.score).toBeLessThan(1);
    expect(v.patch).not.toContain("sum.test.js");
    expect(v.patch).not.toContain("extra.test.js");
  });

  it("ignores hacks to gitignored files like node_modules", async () => {
    const ctx = await bodyAndFork(files);
    // Make the dependency undo the bug instead of fixing sum.js.
    writeFileSync(join(ctx.fork, "node_modules/dep/index.js"), "export const helper = (x) => (x === -1 ? 5 : x);\n");
    const v = await run(ctx);
    expect(v.patch.trim()).toBe("");
    expect(v.score).toBeLessThan(1);
  });

  it("doesn't count a suite that silently lost tests as a pass", async () => {
    const ctx = await bodyAndFork(files);
    writeFileSync(join(ctx.fork, "sum.js"), 'process.exit(0);\nimport { helper } from "dep";\nexport const sum = (a, b) => helper(a + b);\n');
    const v = await run(ctx);
    expect(v.score).toBeLessThan(1);
  });
});
