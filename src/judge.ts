import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Forker } from "./fork/forker.js";
import { type SandboxSpec, runSandboxed } from "./sandbox.js";
import { matchesAny, q } from "./util.js";

/** Files a head may not change. Edits are reverted before the suite runs. */
export const DEFAULT_PROTECT = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "**/conftest.py",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/.mocharc*",
  "**/pytest.ini",
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/tox.ini",
  "**/Cargo.toml",
  "**/go.mod",
  "**/Makefile",
];

/** Git flags that keep repo-local config from running anything. */
const GIT = "git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c color.ui=false";

export interface Counts {
  passed: number | null;
  failed: number | null;
}

/** Pull pass/fail counts out of common test runners' summaries. Last summary wins. */
export function parseCounts(out: string): Counts {
  const last = (re: RegExp): RegExpExecArray | null => {
    let m: RegExpExecArray | null = null;
    let x: RegExpExecArray | null;
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((x = g.exec(out))) m = x;
    return m;
  };
  const num = (s: string | undefined) => (s === undefined ? 0 : Number.parseInt(s, 10));

  // node:test (tap "# pass 3" or spec "ℹ pass 3")
  const np = last(/^[#ℹ]\s*pass (\d+)/m);
  const nf = last(/^[#ℹ]\s*fail (\d+)/m);
  if (np || nf) return { passed: num(np?.[1]), failed: num(nf?.[1]) };

  // vitest: "Tests  2 failed | 9 passed (11)"
  const vt = last(/Tests\s+(?:(\d+) failed)?(?:\s*\|\s*)?(?:(\d+) passed)?[^\n]*\(\d+\)/);
  if (vt && (vt[1] || vt[2])) return { passed: num(vt[2]), failed: num(vt[1]) };

  // jest: "Tests:       2 failed, 9 passed, 11 total"
  const jt = last(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?\d+ total/);
  if (jt) return { passed: num(jt[2]), failed: num(jt[1]) };

  // cargo: "test result: FAILED. 9 passed; 2 failed;"
  const ct = last(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (ct) return { passed: num(ct[1]), failed: num(ct[2]) };

  // pytest: "=== 2 failed, 9 passed in 0.12s ===" (either order, either may be absent)
  const pyLine = last(/^=+ (.*\b(?:passed|failed|error)\b.*) in [\d.]+s/m);
  if (pyLine) {
    const p = /(\d+) passed/.exec(pyLine[1]!);
    const f = /(\d+) failed/.exec(pyLine[1]!);
    const e = /(\d+) errors?/.exec(pyLine[1]!);
    return { passed: num(p?.[1]), failed: num(f?.[1]) + num(e?.[1]) };
  }

  // mocha: "9 passing" / "2 failing"
  const mp = last(/^\s*(\d+) passing/m);
  if (mp) return { passed: num(mp[1]), failed: num(last(/^\s*(\d+) failing/m)?.[1]) };

  // unittest: "Ran 11 tests" + "FAILED (failures=2, errors=1)" or "OK"
  const ran = last(/^Ran (\d+) tests?/m);
  if (ran) {
    const fl = last(/^FAILED \((.*)\)/m);
    let bad = 0;
    if (fl) for (const m of fl[1]!.matchAll(/(?:failures|errors)=(\d+)/g)) bad += num(m[1]);
    return { passed: num(ran[1]) - bad, failed: bad };
  }

  // go test: count "--- PASS" / "--- FAIL"
  const gp = out.match(/^\s*--- PASS/gm)?.length ?? 0;
  const gf = out.match(/^\s*--- FAIL/gm)?.length ?? 0;
  if (gp || gf) return { passed: gp, failed: gf };

  return { passed: null, failed: null };
}

/**
 * Turn a test run into a score in [0, 1]. A clean exit only counts as a full
 * pass if no tests went missing compared with the baseline run.
 */
export function score(exitCode: number | null, c: Counts, baselineTotal: number | null): number {
  const total = c.passed !== null && c.failed !== null ? c.passed + c.failed : null;
  const expected = Math.max(baselineTotal ?? 0, total ?? 0);
  if (exitCode === 0 && (c.failed ?? 0) === 0) {
    if (baselineTotal && total !== null && total < baselineTotal) return (0.99 * total) / baselineTotal;
    return 1;
  }
  if (c.passed !== null && expected > 0) return Math.min(0.99, (0.99 * c.passed) / expected);
  return 0;
}

export interface JudgeConfig {
  testCmd: string;
  baseSha: string;
  protect: RegExp[];
  testTimeoutMs: number;
  maxOutput: number;
  baselineTotal: number | null;
  /** The pristine clone every head descends from. Verdicts are rebuilt on top of it. */
  bodyDir: string;
  forker: Forker;
  /** Where to put body + this head's patch. Becomes the parent if this head leads. */
  stateDir: string;
  /** Scratch dir for the patch file and the test run's temp files. */
  tmpDir: string;
  network: boolean;
  sandbox: boolean;
}

export interface Verdict extends Counts {
  exitCode: number | null;
  score: number;
  diffLines: number;
  filesChanged: number;
  tampered: string[];
  output: string;
  patch: string;
  /** body + patch, or null if the patch wouldn't apply. */
  stateDir: string | null;
}

async function git(spec: SandboxSpec, args: string, signal?: AbortSignal, maxOutput = 200_000) {
  return runSandboxed(`${GIT} ${args} 2>/dev/null`, { ...spec, gitWrite: true, network: false }, { timeoutMs: 60_000, maxOutput, signal });
}

function splitZ(s: string): string[] {
  return s.split("\0").filter(Boolean);
}

/**
 * Judge one head by what it would ship, not by what its workspace looks like.
 *
 * 1. Diff the head's clone against the shared base commit, leaving out any
 *    protected file (tests, test config) it touched.
 * 2. Fork a fresh copy of the body and apply that patch to it.
 * 3. Run the suite on a throwaway clone of that state.
 *
 * Edits to ignored files (node_modules, build output), planted test files and
 * anything else outside the patch never reach the run that decides the score.
 * Every git call runs sandboxed, because the head's clone is untrusted.
 */
export async function judge(spec: SandboxSpec, cfg: JudgeConfig, signal?: AbortSignal): Promise<Verdict> {
  const base = q(cfg.baseSha);
  const tracked = await git(spec, `diff --no-ext-diff --name-only -z ${base}`, signal);
  const untracked = await git(spec, "ls-files --others --exclude-standard -z", signal);
  const changed = [...new Set([...splitZ(tracked.output), ...splitZ(untracked.output)])];
  const tampered = changed.filter((f) => matchesAny(f, cfg.protect));

  await git(spec, "add -A", signal);
  const pathspec = tampered.length ? ` -- . ${tampered.map((f) => q(`:(exclude,literal)${f}`)).join(" ")}` : "";
  const numstat = await git(spec, `diff --cached --no-ext-diff --no-textconv --numstat ${base}${pathspec}`, signal);
  let diffLines = 0;
  let filesChanged = 0;
  for (const line of numstat.output.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    filesChanged++;
    diffLines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
  }
  const patch = (await git(spec, `diff --cached --no-ext-diff --no-textconv --binary ${base}${pathspec}`, signal, 20_000_000)).output;

  const empty = { passed: null, failed: null, exitCode: null, score: 0, diffLines, filesChanged, tampered, patch };
  await mkdir(cfg.tmpDir, { recursive: true });
  await cfg.forker.fork(cfg.bodyDir, [cfg.stateDir]);
  if (patch.trim()) {
    const patchFile = join(cfg.tmpDir, "head.patch");
    await writeFile(patchFile, patch);
    const applied = await runSandboxed(
      `${GIT} apply --whitespace=nowarn ${q(patchFile)}`,
      { root: cfg.stateDir, tmp: cfg.tmpDir, network: false, gitWrite: true, disabled: !cfg.sandbox },
      { timeoutMs: 60_000, maxOutput: 4000, signal },
    );
    if (applied.code !== 0) {
      await rm(cfg.stateDir, { recursive: true, force: true });
      return { ...empty, output: `The head's patch didn't apply to a clean copy:\n${applied.output}`, stateDir: null };
    }
  }

  const testDir = `${cfg.stateDir}.run`;
  await cfg.forker.fork(cfg.stateDir, [testDir]);
  const run = await runSandboxed(
    cfg.testCmd,
    { root: testDir, tmp: cfg.tmpDir, network: cfg.network, gitWrite: false, disabled: !cfg.sandbox },
    { timeoutMs: cfg.testTimeoutMs, maxOutput: cfg.maxOutput, signal },
  );
  await rm(testDir, { recursive: true, force: true });

  const counts = parseCounts(run.output);
  const exitCode = run.timedOut ? null : run.code;
  return {
    ...empty,
    ...counts,
    exitCode,
    score: run.timedOut || run.aborted ? 0 : score(exitCode, counts, cfg.baselineTotal),
    output: run.output,
    stateDir: cfg.stateDir,
  };
}
