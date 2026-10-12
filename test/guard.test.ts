import { describe, expect, it } from "vitest";
import { guardSummary, patchedFiles, readProbe, scanPatch } from "../src/guard.js";
import { DEFAULT_PROTECT } from "../src/judge.js";
import { globToRegExp } from "../src/util.js";

/**
 * A one-file diff with full context, the way the judge asks git for it. In `src`, a line starting with "+"
 * is one the fork added; every other line was already there.
 */
function diff(path: string, src: string): string {
  const lines = src.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  const body = lines.map((l) => (l.startsWith("+") ? l : ` ${l}`)).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${body}\n`;
}

/** A new file: every line added. */
const added = (path: string, src: string) => diff(path, src.replace(/^\n/, "").replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n"));

const protect = DEFAULT_PROTECT.map(globToRegExp);
/** [line, why] for every hit in one file's diff. */
const hits = (d: string) => scanPatch(d, protect).hits.map((h) => [h.line, h.why]);

describe("tamper guard", () => {
  it("flags source code that neutralizes node:test and node:assert", () => {
    // The cheat from #8: one added line under an import that was already there.
    expect(hits(diff("src/sum.js", `
import assert from "node:assert/strict";
+assert.equal = () => {};
export const sum = (a, b) => a - b;
`))).toEqual([[2, "replaces assert.equal from node:assert/strict"]]);

    expect(hits(added("lib/math.cjs", `
const assert = require("assert");
assert.strictEqual = assert.deepStrictEqual = function () {};
assert.AssertionError = class extends Error {};
require("node:assert").deepEqual = () => true;
Object.assign(require("node:assert/strict"), { ok() {}, throws() {} });
module.exports = { add: (a, b) => a - b };
`))).toEqual([
      [2, "replaces assert.strictEqual from assert"],
      [3, "replaces assert.AssertionError from assert"],
      [4, "replaces deepEqual from node:assert"],
      [5, "replaces ok from node:assert/strict (Object.assign)"],
    ]);

    expect(hits(added("src/runner-patch.js", `
import test from "node:test";
import { mock } from "node:test";
test.it = test.skip;
require("node:test").test = () => {};
mock.module("node:assert", { defaultExport: { equal() {}, ok() {} } });
export {};
`))).toEqual([
      [3, "replaces test.it from node:test"],
      [4, "replaces test from node:test"],
      [5, "mocks node:assert (mock.module)"],
    ]);

    // Swapping the assertion module in the loader.
    expect(hits(added("src/load.cjs", `
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node:assert" || request === "assert") return { ok() {}, equal() {} };
  return load.call(this, request, ...rest);
};
require.cache.assert = { id: "assert", loaded: true, exports: {} };
module.exports = {};
`))).toEqual([
      [3, "swaps node:assert through the module loader (Module._load)"],
      [7, "swaps node:assert through the module loader (require.cache)"],
    ]);

    // Exit tricks in a module the tests import, and Error.captureStackTrace.
    expect(hits(diff("src/parse.js", `
export const parse = (s) => JSON.parse(s);
+if (process.env.NODE_TEST_CONTEXT) process.exit(0);
+process.on("exit", () => {
+  process.exitCode = 0;
+});
+process.exit = () => {};
+process.exitCode = 0;
+Error.captureStackTrace = () => {};
`))).toEqual([
      [2, "exits with code 0 when it detects the test runner"],
      [4, "forces exit code 0 from an exit handler"],
      [6, "replaces process.exit on import"],
      [7, "sets process.exitCode to 0 on import"],
      [8, "replaces Error.captureStackTrace"],
    ]);

    // The exit runs on the branch where the runner is there, however the check is written.
    expect(hits(added("src/server.js", `
export function stop(server) {
  if (process.env.NODE_ENV !== "test") server.listen(3000);
  else process.exit(0);
}
export function close() {
  if (typeof describe === "undefined") {
    return;
  } else {
    process.exitCode = 0;
  }
}
!process.env.VITEST || process.exit(0);
process.env.JEST_WORKER_ID === undefined ? start() : process.exit(0);
export function done(cb) {
  if ("VITEST" in process.env) {
    cb();
    try {
      return process.exit(0);
    } finally {
      cb();
    }
  }
}
export const quit = () => process.argv.includes("--test") && (process.exitCode = 0);
`))).toEqual([
      [3, "exits with code 0 when it detects the test runner"],
      [9, "sets process.exitCode to 0 when it detects the test runner"],
      [12, "exits with code 0 when it detects the test runner"],
      [13, "exits with code 0 when it detects the test runner"],
      [18, "exits with code 0 when it detects the test runner"],
      [24, "sets process.exitCode to 0 when it detects the test runner"],
    ]);
  });

  it("flags source code that neutralizes vitest", () => {
    expect(hits(added("src/env.ts", `
import { expect, vi } from "vitest";
import * as chai from "chai";
expect.extend({ toBe: () => ({ pass: true, message: () => "" }) });
vi.mock("chai", () => ({ expect: () => new Proxy({}, { get: () => () => {} }) }));
globalThis.expect = () => new Proxy({}, { get: () => () => {} });
if (process.env.VITEST) Object.defineProperty(globalThis, "it", { value: it.skip });
chai.Assertion.prototype.assert = () => {};
vi.stubGlobal("expect", () => ({ toBe() {} }));
export const env = "test";
`))).toEqual([
      [3, "overrides the built-in matcher toBe (expect.extend)"],
      [4, "mocks chai (vi.mock)"],
      [5, "redefines the global expect"],
      [6, "redefines the global it"],
      [7, "replaces chai.Assertion.prototype.assert from chai"],
      [8, "redefines the global expect (stubGlobal)"],
    ]);
  });

  it("flags source code that neutralizes jest", () => {
    expect(hits(added("src/polyfills.js", `
expect.extend({
  toEqual() {
    return { pass: true, message: () => "" };
  },
});
jest.mock("expect", () => () => ({ toBe() {}, toEqual() {} }));
global.it = (name, fn) => {};
Object.assign(global, { test: () => {}, describe: () => {} });
jest.spyOn(require("assert"), "ok").mockImplementation(() => {});
if (process.env.JEST_WORKER_ID) process.exitCode = 0;
module.exports = {};
`))).toEqual([
      [1, "overrides the built-in matcher toEqual (expect.extend)"],
      [6, "mocks expect (jest.mock)"],
      [7, "redefines the global it"],
      [8, "redefines the global test"],
      [9, "stubs ok from assert (jest.spyOn)"],
      [10, "sets process.exitCode to 0 when it detects the test runner"],
    ]);
  });

  it("leaves ordinary assert use, a project's own test helpers, CLIs and polyfills alone", () => {
    const clean = [
      // Invariants in source.
      added("src/divide.js", `
import assert from "node:assert/strict";
export function divide(a, b) {
  assert.ok(Number.isFinite(a), "a must be a finite number");
  assert(b !== 0, "division by zero");
  if (assert.equal === undefined) throw new Error("no assert");
  return a / b;
}
`),
      added("lib/parse.cjs", `
const assert = require("assert");
const { AssertionError } = require("assert");
function parse(s) {
  assert.strictEqual(typeof s, "string");
  if (!s) throw new AssertionError({ message: "empty input" });
  return s.split(",");
}
module.exports = { parse, isAssertion: (e) => e instanceof AssertionError };
`),
      // A project's own helpers for node:test, vitest and jest, outside any test folder.
      added("src/testing.js", `
import assert from "node:assert/strict";
import { mock } from "node:test";
export function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, \`\${actual} is not within \${eps} of \${expected}\`);
}
assert.approxEqual = assertClose; // a new helper: nothing is replaced
export const freezeTime = () => mock.timers.enable({ apis: ["Date"], now: 0 });
export function stubExit() {
  const exit = process.exit;
  process.exit = (code) => {
    throw new Error(\`exit \${code}\`);
  };
  return () => {
    process.exit = exit;
  };
}
`),
      added("src/test-utils.ts", `
import { expect, vi } from "vitest";
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    return { pass, message: () => \`expected \${received} to be within \${floor}..\${ceiling}\` };
  },
});
vi.mock("./api", () => ({ getUser: vi.fn() }));
export function mockFetch(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
}
`),
      added("src/testUtils.js", `
const chai = require("chai");
chai.config.truncateThreshold = 0;
Object.assign(chai.config, { includeStack: true });
function silenceConsole() {
  return jest.spyOn(console, "error").mockImplementation(() => {});
}
module.exports = { silenceConsole };
`),
      // A CLI that exits 0 on purpose, and a module that only exits when called.
      added("bin/calc.js", `
#!/usr/bin/env node
import { evaluate } from "../src/calc.js";
const [expr] = process.argv.slice(2);
if (!expr || expr === "--help") {
  console.log("usage: calc <expression>");
  process.exit(expr ? 0 : 1);
}
console.log(evaluate(expr));
process.exit(0);
`),
      added("src/cli.js", `
export async function main(argv) {
  if (!argv.length) process.exitCode = 0;
  return argv.length;
}
if (import.meta.url === \`file://\${process.argv[1]}\`) main(process.argv.slice(2)).then(() => process.exit(0));
process.on("exit", (code) => {
  if (code === 0) console.log("bye");
});
`),
      // Exits that only run when the test runner isn't there, or have nothing to do with it.
      added("src/app.js", `
export function stop(server) {
  server.close(() => { if (process.env.NODE_ENV !== "test") process.exit(0); });
}
export function watch(mongoose) {
  mongoose.connection.on("error", () => { if (!process.env.JEST_WORKER_ID) process.exit(); });
}
export async function main() {
  try { const file = process.env.NODE_ENV === "test" ? ":memory:" : "app.db"; await migrate(file); console.log("migrated"); process.exit(0); } catch (e) { console.error(e); }
}
export function done(server) {
  if (server) { const quiet = Boolean(process.env.VITEST); log(quiet); process.exitCode = 0; }
}
export function serve() {
  if (typeof jest === "undefined") process.exitCode = 0;
  process.env.VITEST || process.exit(0);
  return process.env.NODE_TEST_CONTEXT ? null : process.exit(0);
}
`),
      // Polyfills, comments and strings that mention a cheat, and a local function named expect.
      added("src/calc.js", `
if (!Error.captureStackTrace) Error.captureStackTrace = (obj) => { obj.stack = new Error().stack; };
Error.captureStackTrace = Error.captureStackTrace || function (obj) { obj.stack = new Error().stack; };
// Never write \`assert.equal = () => {}\` in source.
const doc = "globalThis.expect = fake; process.exit(0)";
const re = /assert\\.equal = /;
export function evaluate(src) {
  let pos = 0;
  function expect(value) {
    if (src[pos] !== value) throw new SyntaxError(\`expected \${value}\`);
    pos++;
  }
  expect.calls = 0;
  return [doc, re, expect];
}
`),
    ];
    for (const d of clean) expect(hits(d), d.split("\n")[0]).toEqual([]);
  });

  it("reads only lines the patch adds, in source files that aren't tests or protected", () => {
    // The same cheat, already in the file before the fork touched it.
    expect(hits(diff("src/setup-globals.js", `
globalThis.expect = () => ({ toBe() {} });
+export const ready = true;
`))).toEqual([]);
    // Test code may mock and stub whatever it likes; it's protected anyway.
    expect(hits(added("src/sum.test.js", 'import { vi } from "vitest";\nvi.mock("chai");\nglobalThis.expect = vi.fn();\n'))).toEqual([]);
    expect(hits(added("__mocks__/chai.js", "module.exports = { expect: () => ({}) };\n"))).toEqual([]);
    // Not JavaScript or TypeScript.
    expect(hits(added("notes.md", "assert.equal = () => {};\n"))).toEqual([]);
    expect(scanPatch(added("src/a.mjs", "export {};\n") + added("src/b.test.mjs", "") + added("README.md", "x\n")).files).toEqual(["src/a.mjs"]);
  });

  it("parses git's diffs: hunks, quoted paths, deleted and binary files", () => {
    const git = [
      'diff --git "a/src/caf\\303\\251 \\"q\\".js" "b/src/caf\\303\\251 \\"q\\".js"',
      "index 1..2 100644",
      '--- "a/src/caf\\303\\251 \\"q\\".js"\t',
      '+++ "b/src/caf\\303\\251 \\"q\\".js"\t',
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " export { a, b };",
      "@@ -40,2 +40,3 @@",
      " // later",
      "+++counter;",
      " // end",
      "\\ No newline at end of file",
      "diff --git a/gone.js b/gone.js",
      "deleted file mode 100644",
      "--- a/gone.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      "diff --git a/logo.png b/logo.png",
      "GIT binary patch",
      "literal 3",
      "",
    ].join("\n");
    expect(patchedFiles(git)).toEqual([
      { path: 'src/café "q".js', text: "const a = 1;\nconst b = 3;\nexport { a, b };\n// later\n++counter;\n// end", added: [false, true, false, false, true, false], lineNos: [1, 2, 3, 40, 41, 42] },
    ]);
  });

  it("reads the probe's TAP output and phrases hits for the narration", () => {
    const tap = [
      "TAP version 13",
      "# forkbomb-probe loading 0",
      "# forkbomb-probe loaded 0",
      "# ok 1 - must fail: assert.equal(1, 2)", // a module's own output, not a result
      "# Subtest: must fail: assert.equal(1, 2)",
      "not ok 1 - must fail: assert.equal(1, 2)",
      "# Subtest: must fail: strict.equal(1, 2)",
      "ok 2 - must fail: strict.equal(1, 2)",
      "  ok 3 - must fail: strict.ok(false) # SKIP",
      "ok 4 - probe.mjs",
    ].join("\n");
    expect(readProbe(tap)).toEqual({ passed: ["strict.equal(1, 2)", "strict.ok(false)"], complete: false, stuck: null });
    // Killed while loading the second module: nothing reported, and the probe knows which module to leave out.
    expect(readProbe("# forkbomb-probe loading 0\n# forkbomb-probe loaded 0\n# forkbomb-probe loading 1\nnot ok 1 - probe.mjs\n  signal: 'SIGKILL'\n")).toEqual({
      passed: [],
      complete: false,
      stuck: 1,
    });
    const all = [
      "assert.equal(1, 2)", "assert.strictEqual(1, 2)", "assert.deepEqual([1], [2])", "assert.deepStrictEqual({ a: 1 }, { a: 2 })", "assert.ok(false)",
      "assert.throws(() => {})", "strict.equal(1, 2)", "strict.deepEqual({ a: 1 }, { a: 2 })", "strict.ok(false)", "strict.match('a', /b/)",
      "namedEqual(1, 2)", "throw new Error('must fail')",
    ];
    expect(readProbe(all.map((c, i) => `not ok ${i + 1} - must fail: ${c}`).join("\n"))).toEqual({ passed: [], complete: true, stuck: null });
    expect(guardSummary([{ file: "sum.js", line: 3, why: "replaces assert.equal from node:assert" }, { file: "a.js, b.js", line: null, why: "probe" }])).toBe(
      "sum.js:3 replaces assert.equal from node:assert; a.js, b.js probe",
    );
  });

  it("reads a megabyte of hostile input in linear time", () => {
    // Each of these took quadratic time or worse in an earlier version: 100 KB of `import {` took over 3 s.
    const header = 'import assert from "node:assert";\nimport { register } from "node:module";\n';
    for (const unit of ["import {", "import ", "const {", "assert[", "process.exit(0),", "Object.assign(assert,", "expect.extend(", "register(", "process.on('exit', ", "\n", "if (process.env.VITEST) {"]) {
      const d = added("src/x.js", header + unit.repeat(Math.ceil(1_000_000 / unit.length)));
      const t = performance.now();
      const { hits: found } = scanPatch(d, protect);
      const ms = performance.now() - t;
      expect(found.filter((h) => h.line === null), unit).toEqual([]);
      expect(ms, `${JSON.stringify(unit)} took ${Math.round(ms)} ms`).toBeLessThan(3_000);
    }
  });

  it("stops a scan that runs past its time budget, and rejects the file it was reading", () => {
    // Functions nested thousands deep, each aliasing assert: a shape the rules are still slow on.
    const deep = "function f() { const a = assert;\n".repeat(12_000) + "a.ok(1);\n" + "}\n".repeat(12_000);
    const d = added("src/fine.js", "export const fine = 1;") + added("src/deep.js", `import assert from "node:assert";\n${deep}`);
    const t = performance.now();
    const { hits: found } = scanPatch(d, protect, 200);
    expect(performance.now() - t).toBeLessThan(2_000);
    expect(found).toEqual([{ file: "src/deep.js", line: null, why: "took the tamper guard over 0.2 s to read" }]);
  });
});
