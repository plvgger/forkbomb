import { cpSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROTECT, brokenTestCommand, literalRegExp, parseCounts, testInfraFiles } from "../src/judge.js";
import { runSandboxed } from "../src/sandbox.js";
import { globToRegExp, matchesAny } from "../src/util.js";
import { tempDir } from "./helpers.js";

const EXAMPLES = join(process.cwd(), "examples");
const TEST_CMD = "node --test";

interface Row {
  name: string;
  link: string;
  passed: number;
  total: number;
  command: string;
}

/** The table in examples/README.md, one row per example. */
function index(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(join(EXAMPLES, "README.md"), "utf8").split("\n")) {
    const m = /^\| \[([\w-]+)\]\(([^)]*)\) \| .+ \| (\d+)\/(\d+) \| `([^`]+)` \|$/.exec(line);
    if (m) rows.push({ name: m[1]!, link: m[2]!, passed: Number(m[3]), total: Number(m[4]), command: m[5]! });
  }
  return rows;
}

const rows = index();
const dirs = readdirSync(EXAMPLES).filter((f) => statSync(join(EXAMPLES, f)).isDirectory());

describe("examples", () => {
  it("are all in the index, each with a run command for its own folder", () => {
    expect(rows.map((r) => r.name).sort()).toEqual([...dirs].sort());
    for (const r of rows) {
      expect(r.link, r.name).toBe(`${r.name}/`);
      expect(r.command, r.name).toBe(`forkbomb run ./examples/${r.name} --task "fix the failing tests" --test "${TEST_CMD}" --forks 4`);
    }
  });

  it("are plain ES module packages tested with node --test, with no dependencies", () => {
    for (const name of dirs) {
      const pkg = JSON.parse(readFileSync(join(EXAMPLES, name, "package.json"), "utf8")) as Record<string, unknown>;
      expect(pkg, name).toMatchObject({ name, private: true, type: "module", scripts: { test: TEST_CMD } });
      for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) expect(pkg[key], `${name} ${key}`).toBeUndefined();
    }
  });

  it("let forks change the code but not the tests", async () => {
    for (const name of dirs) {
      const dir = join(EXAMPLES, name);
      // What the judge reverts: the default protect globs plus the files the test command runs.
      const protect = [...DEFAULT_PROTECT.map(globToRegExp), ...(await testInfraFiles(dir, TEST_CMD)).map(literalRegExp)];
      const files = readdirSync(dir).filter((f) => !f.startsWith("."));
      const tests = files.filter((f) => f.endsWith(".test.js"));
      const code = files.filter((f) => f.endsWith(".js") && !tests.includes(f));
      expect(files.sort(), name).toEqual([...code, ...tests, "package.json"].sort());
      expect(tests.length, name).toBeGreaterThan(0);
      expect(code.length, name).toBeGreaterThan(0);
      for (const f of [...tests, "package.json"]) expect(matchesAny(f, protect), `${name}/${f}`).toBe(true);
      for (const f of code) expect(matchesAny(f, protect), `${name}/${f}`).toBe(false);
    }
  });

  for (const row of rows) {
    it(`${row.name}: the baseline is ${row.passed}/${row.total}, as the index says`, async () => {
      // A sandboxed run on a copy, with the CLI's default output cap: the baseline a race starts from.
      const copy = join(tempDir(`example-${row.name}`), row.name);
      cpSync(join(EXAMPLES, row.name), copy, { recursive: true });
      const run = await runSandboxed(TEST_CMD, { root: copy, tmp: `${copy}-tmp`, network: false, gitWrite: false }, { timeoutMs: 60_000, maxOutput: 12_000 });
      const counts = parseCounts(run.output);
      expect(brokenTestCommand(run, counts, 60_000), run.output).toBeNull();
      expect(counts, run.output).toEqual({ passed: row.passed, failed: row.total - row.passed });
      expect(run.code).toBe(1);
      // Some tests pass and most fail, so a race has work to do and a baseline to beat.
      expect(row.passed).toBeGreaterThan(0);
      expect(row.passed * 2).toBeLessThan(row.total);
    });
  }
});
