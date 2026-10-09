import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Forker } from "./fork/forker.js";
import { type RunOutcome, type SandboxSpec, runSandboxed } from "./sandbox.js";
import { matchesAny, q } from "./util.js";

/**
 * Files a fork may not change. Edits are reverted before the suite runs. Beyond the tests themselves this
 * covers what the test toolchain loads before any test runs: runner and compiler config, setup files,
 * manifests and lockfiles. testInfraFiles() adds the scripts a particular test command runs.
 */
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
  "**/tsconfig*.json",
  "**/jsconfig*.json",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.swcrc",
  "**/vitest.workspace.*",
  "**/vitest.setup.*",
  "**/jest.setup.*",
  "**/setupTests.*",
  "**/jest.preset.*",
  "**/karma.conf.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/.nycrc*",
  "**/.c8rc*",
  "**/.npmrc",
  "**/.yarnrc*",
  "**/bunfig.toml",
  "**/deno.json",
  "**/deno.jsonc",
  "**/noxfile.py",
  "**/sitecustomize.py",
  "**/usercustomize.py",
  "**/Cargo.lock",
  "**/go.sum",
  "**/Gemfile",
  "**/Gemfile.lock",
  "**/.rspec",
  "**/phpunit.xml*",
  "**/pom.xml",
  "**/build.gradle*",
  "**/settings.gradle*",
];

/** A regex matching exactly one repo-relative path (testInfraFiles' results), whatever characters it holds. */
export function literalRegExp(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Words of a shell command line: split on blanks and operators, quotes stripped, `--opt=value` split into both. */
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|()<>]+)/g)) {
    const w = m[1] ?? m[2] ?? m[3] ?? "";
    out.push(w);
    const eq = /^--?[\w-]+=(.+)$/.exec(w);
    if (eq) out.push(eq[1]!);
  }
  return out;
}

/** Keys in a test runner's config whose values name files it loads before any test runs. */
const SETUP_KEYS =
  /["']?\b(setupFiles|setupFilesAfterEnv|globalSetup|globalTeardown|setupFile|require|file|loader|import|testEnvironment|runner|testRunner|snapshotResolver|testSequencer|resolver|reporters|transform|watchPlugins)\b["']?\s*[:=]\s*(\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|`[^`]*`)/g;

/**
 * Files outside the protect globs that the test command still runs or loads: a script it names
 * (`node runner.mjs`, `bash scripts/test.sh`, `--import ./setup.mjs`), the same in the package.json
 * scripts it runs (test, pretest, posttest and any `npm run X` they chain), and setup files named in
 * the runner's config (vitest/jest setupFiles, globalSetup, mocha require). A fork that edits one of
 * these could make the suite report a pass without fixing anything, so they are read-only like tests.
 * Returns repo-relative paths of regular files inside `root`.
 */
export async function testInfraFiles(root: string, testCmd: string): Promise<string[]> {
  const rootReal = await realpath(root);
  const found = new Set<string>();
  const consider = async (word: string, from = rootReal) => {
    const w = word.replace(/^<rootDir>\//, "").trim();
    if (!w || w.length > 400 || /[*?\n]/.test(w) || /^[a-z][\w+.-]*:/i.test(w)) return; // globs, URLs, node:x
    const abs = isAbsolute(w) ? w : join(from, w);
    const real = await realpath(abs).catch(() => null);
    if (!real) return;
    const rel = relative(rootReal, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    if (!(await stat(real).catch(() => null))?.isFile()) return;
    found.add(rel.split(sep).join("/"));
  };

  const pkg = await readFile(join(rootReal, "package.json"), "utf8")
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => null);
  const scripts = (pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;

  // The command, then every package.json script it reaches.
  const lines = [testCmd];
  const queued = new Set<string>();
  const queue = (name: string) => {
    for (const n of [`pre${name}`, name, `post${name}`]) {
      if (!queued.has(n) && typeof scripts[n] === "string") {
        queued.add(n);
        lines.push(scripts[n] as string);
      }
    }
  };
  for (let i = 0; i < lines.length && i < 50; i++) {
    const words = shellWords(lines[i]!);
    for (const w of words) await consider(w);
    if (words.some((w) => /^(?:npm|pnpm|yarn|bun)$/.test(w))) {
      for (const w of words) if (w === "t" || Object.hasOwn(scripts, w)) queue(w === "t" ? "test" : w);
    }
  }

  // Setup files named in the runner's config: config files at the root and package.json's runner blocks.
  const configs: Array<{ text: string; dir: string; all: boolean }> = [];
  for (const key of ["jest", "mocha", "ava", "vitest"]) {
    if (pkg?.[key] && typeof pkg[key] === "object") configs.push({ text: JSON.stringify(pkg[key]), dir: rootReal, all: false });
  }
  for (const name of await readdir(rootReal).catch(() => [] as string[])) {
    const mocharc = /^\.mocharc(?:\.\w+)?$/.test(name);
    if (!mocharc && !/^(?:vitest|vite|jest|karma|playwright|cypress|vitest\.workspace)\.config\.[cm]?[jt]s$|^vitest\.workspace\.[cm]?[jt]s$/.test(name)) continue;
    const text = await readFile(join(rootReal, name), "utf8").catch(() => "");
    // A .mocharc is all test config: anything in it that names a file counts.
    configs.push({ text: text.slice(0, 200_000), dir: rootReal, all: mocharc });
  }
  for (const c of configs) {
    const values = c.all ? [c.text] : [...c.text.matchAll(SETUP_KEYS)].map((m) => m[2]!);
    for (const v of values) {
      for (const m of v.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s"'`,:\[\]{}]+)/g)) await consider(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", c.dir);
    }
  }
  return [...found].sort();
}

/**
 * Why a baseline run says the test command itself is broken, so that forking would only spend sessions
 * on a suite that can never pass; null when it looks like a real suite (passing or failing).
 */
export function brokenTestCommand(run: RunOutcome, counts: Counts, testTimeoutMs: number): string | null {
  const tail = run.output.trim().split("\n").slice(-4).join("\n");
  if (run.timedOut) {
    // A suite that printed its results and kept running is a watch mode or an open handle. One that printed
    // nothing may be hanging on the very bug the forks are meant to fix, so that one still runs.
    if (counts.passed === null && counts.failed === null) return null;
    return `the test command printed its results but didn't exit within --test-timeout (${Math.round(testTimeoutMs / 1000)}s), so every fork's run would time out too. Use a command that exits on its own (for example \`vitest run\`, not watch mode).`;
  }
  if (run.code === 127 || run.code === 126) {
    return `the test command couldn't run (exit ${run.code}: ${run.code === 127 ? "command not found" : "not executable"}). Check --test.\n${tail}`;
  }
  if (counts.passed === null && counts.failed === null && run.code !== 0 && /Missing script: |missing script:|ERR_PNPM_NO_SCRIPT|Command "[^"]+" not found|ENOENT[^\n]*package\.json/.test(run.output)) {
    return `the test command names a script that doesn't exist. Check --test.\n${tail}`;
  }
  return null;
}

/**
 * Why `npm run <name>` / `npm test` (pnpm, yarn alike) can't run: the script isn't in the repo's package.json.
 * Read from package.json before the baseline, so it doesn't depend on how a package manager words or times its
 * error. null when the command isn't of that form, has extra flags before the script, or package.json is unreadable.
 */
export async function missingScript(repoDir: string, testCmd: string): Promise<string | null> {
  const m =
    /^\s*(?:npm|pnpm|bun)\s+run(?:-script)?\s+([^\s;&|<>]+)/.exec(testCmd) ??
    /^\s*yarn\s+run\s+([^\s;&|<>]+)/.exec(testCmd) ??
    /^\s*(?:npm|pnpm|yarn)\s+(test)(?=\s|$)/.exec(testCmd) ??
    /^\s*npm\s+(?:t|tst)(?=\s|$)/.exec(testCmd);
  if (!m) return null;
  const name = m[1] ?? "test";
  if (name.startsWith("-")) return null;
  let scripts: unknown;
  try {
    scripts = (JSON.parse(await readFile(join(repoDir, "package.json"), "utf8")) as { scripts?: unknown }).scripts;
  } catch {
    return null;
  }
  if (scripts && typeof scripts === "object" && Object.hasOwn(scripts, name)) return null;
  return `the test command names a script that doesn't exist ("${name}" isn't in package.json's scripts). Check --test.`;
}

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
  /** The pristine clone every fork descends from. Verdicts are rebuilt on top of it. */
  bodyDir: string;
  forker: Forker;
  /** Where to put body + this fork's patch. Becomes the parent if this fork leads. */
  stateDir: string;
  /** Scratch dir for the patch file and the test run's temp files. */
  tmpDir: string;
  network: boolean;
  sandbox: boolean;
  /** Folders the apply step and the test run may not read (the runs folder), as in SandboxSpec.denyRead. */
  denyRead?: string[];
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
 * Judge one fork by what it would ship, not by what its workspace looks like.
 *
 * 1. Diff the fork's clone against the shared base commit, leaving out any
 *    protected file (tests, test config) it touched.
 * 2. Fork a fresh copy of the body and apply that patch to it.
 * 3. Run the suite on a throwaway clone of that state.
 *
 * Edits to ignored files (node_modules, build output), planted test files and
 * anything else outside the patch never reach the run that decides the score.
 * Every git call runs sandboxed, because the fork's clone is untrusted.
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
    const patchFile = join(cfg.tmpDir, "fork.patch");
    await writeFile(patchFile, patch);
    const applied = await runSandboxed(
      `${GIT} apply --whitespace=nowarn ${q(patchFile)}`,
      { root: cfg.stateDir, tmp: cfg.tmpDir, network: false, gitWrite: true, disabled: !cfg.sandbox, denyRead: cfg.denyRead },
      { timeoutMs: 60_000, maxOutput: 4000, signal },
    );
    if (applied.code !== 0) {
      await rm(cfg.stateDir, { recursive: true, force: true });
      return { ...empty, output: `The fork's patch didn't apply to a clean copy:\n${applied.output}`, stateDir: null };
    }
  }

  const testDir = `${cfg.stateDir}.run`;
  await cfg.forker.fork(cfg.stateDir, [testDir]);
  const run = await runSandboxed(
    cfg.testCmd,
    { root: testDir, tmp: cfg.tmpDir, network: cfg.network, gitWrite: false, disabled: !cfg.sandbox, denyRead: cfg.denyRead },
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
