import { realpathSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ForkResult, type ModelClient, runFork, systemPrompt } from "./agent.js";
import { BRAND } from "./brand.js";
import { claudeSettings, keyFiles, runClaudeCodeFork } from "./engines/claude-code.js";
import { type CreditGate, type HostedChat, chargedSince, runHostedFork } from "./engines/hosted.js";
import type { EventBus } from "./events.js";
import { type Forker, pickForker } from "./fork/forker.js";
import { DEFAULT_PROTECT, brokenTestCommand, judge, literalRegExp, parseCounts, score, testInfraFiles } from "./judge.js";
import { type SandboxSpec, runSandboxed } from "./sandbox.js";
import { strategyFor } from "./strategies.js";
import { Workspace } from "./tools.js";
import { Semaphore, exec, fmtBytes, freeBytes, globToRegExp, matchesAny, treeBytes } from "./util.js";

export interface RunOptions {
  runId: string;
  repo: string;
  task: string;
  testCmd: string;
  forks: number;
  rounds: number;
  mode: "race" | "best";
  /** API engine: talks to the Messages API with an API key. */
  model?: ModelClient;
  /** Claude Code engine: drives `claude -p` on the user's Claude Code login (subscription). */
  claudeCode?: { model?: string; bin?: string };
  /** Hosted engine: an OpenAI-compatible gateway paid for with burned-token credit. */
  hosted?: HostedChat;
  effort: string;
  maxTurns: number;
  forkTimeoutMs: number;
  bashTimeoutMs: number;
  testTimeoutMs: number;
  maxOutput: number;
  network: boolean;
  sandbox: boolean;
  protect: string[];
  apply: boolean;
  keepForks: boolean;
  runsDir: string;
  concurrency: number;
  forker?: Forker;
  /** Aborting it stops the run: every fork, judge and test run is killed, nothing is applied, and run_end says so. */
  signal?: AbortSignal;
  /** Also make read-only the scripts and setup files the test command runs or loads (see testInfraFiles). Default on. */
  protectTestInfra?: boolean;
  /** Stop every fork when free disk space falls below this. Default: 1 GiB, or half of what was free at the start if less. */
  diskFloorBytes?: number;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  ok: boolean;
  winner: string | null;
  best: string | null;
  bestScore: number;
  patchPath: string | null;
  applied: boolean;
  costUsd: number | null;
  /** costUsd includes local estimates the hosted balance couldn't confirm. */
  costApprox: boolean;
  interrupted: boolean;
  error?: string;
}

interface ForkRecord {
  id: string;
  dir: string;
  /** body + this fork's patch, verified by the judge. Next rounds grow from here. */
  stateDir: string;
  strategy: string;
  score: number;
  passed: number | null;
  failed: number | null;
  diffLines: number;
  filesChanged: number;
  patch: string;
  summary: string;
  tail: string;
  finishedAt: number;
}

const GIT_TRUSTED = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", `user.name=${BRAND.name}`,
  "-c", `user.email=${BRAND.slug}@localhost`,
];

/**
 * Snapshot the body as a commit every fork shares. Runs before any fork
 * exists, on a fresh clone of the user's repo, so it is trusted.
 */
async function initBase(dir: string): Promise<string> {
  const gitPath = join(dir, ".git");
  const st = await lstat(gitPath).catch(() => null);
  // A .git *file* points at another repo (worktree, submodule). Never write into that.
  if (st && !st.isDirectory()) await rm(gitPath, { force: true });
  if (!st || !st.isDirectory()) {
    const init = await exec("git", ["-C", dir, "init", "-q"]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const add = await exec("git", [...GIT_TRUSTED, "-C", dir, "add", "-A"], { env });
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await exec("git", [...GIT_TRUSTED, "-C", dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", `${BRAND.slug}: base`], { env });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  const head = await exec("git", ["-C", dir, "rev-parse", "HEAD"], { env });
  return head.stdout.trim();
}

async function applyPatch(repo: string, patchFile: string): Promise<{ ok: boolean; error?: string }> {
  // Inside a git repo, apply paths are relative to the top level; prefix them with our subdir.
  const prefix = await exec("git", ["-C", repo, "rev-parse", "--show-prefix"]);
  const args = ["-C", repo, "apply", "--whitespace=nowarn"];
  const p = prefix.code === 0 ? prefix.stdout.trim().replace(/\/$/, "") : "";
  if (p) args.push(`--directory=${p}`);
  args.push(patchFile);
  const r = await exec("git", args);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

async function withSlot<T>(slots: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await slots.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function tailOf(s: string, n = 1500): string {
  return s.length > n ? s.slice(-n) : s;
}

function better(a: ForkRecord, b: ForkRecord | null): boolean {
  if (!b) return true;
  if (a.score !== b.score) return a.score > b.score;
  if (a.diffLines !== b.diffLines) return a.diffLines < b.diffLines;
  return a.finishedAt < b.finishedAt;
}

export async function runRace(o: RunOptions, bus: EventBus): Promise<RunSummary> {
  const t0 = performance.now();
  const repo = realpathSync(o.repo);
  const runsDir = realpathSync(o.runsDir);
  const runDir = join(runsDir, o.runId);
  await mkdir(join(runDir, "forks"), { recursive: true });
  await mkdir(join(runDir, "state"), { recursive: true });
  await mkdir(join(runDir, "tmp"), { recursive: true });

  const protect = o.protect.map(globToRegExp);
  const apiSlots = new Semaphore(o.concurrency);
  let costUsd: number | null = 0;
  let estimatedUsd = 0;
  const addCost = (r: ForkResult) => {
    costUsd = costUsd === null || r.costUsd === null ? null : costUsd + r.costUsd;
    estimatedUsd += r.costEstimatedUsd ?? 0;
  };
  const interrupted = () => !!o.signal?.aborted;
  const summary = (extra: Partial<RunSummary>): RunSummary => ({
    runId: o.runId,
    runDir,
    ok: false,
    winner: null,
    best: null,
    bestScore: 0,
    patchPath: null,
    applied: false,
    costUsd,
    costApprox: costUsd !== null && estimatedUsd > 0,
    interrupted: interrupted(),
    ...extra,
  });
  /** Ends a run that never got to race: no forks, nothing to clean but the temp dir. */
  const endEarly = async (ok: boolean, bestScore: number, error?: string): Promise<RunSummary> => {
    await rm(join(runDir, "tmp"), { recursive: true, force: true });
    // Nothing ran, so nothing was spent; on a Claude plan there's no dollar figure at all.
    const spent = o.claudeCode ? null : 0;
    bus.emit({ type: "run_end", ok, ms: Math.round(performance.now() - t0), costUsd: spent, applied: false, patchPath: null, best: null, bestScore, ...(interrupted() ? { interrupted: true } : {}) });
    return summary({ ok, bestScore, costUsd: spent, ...(error ? { error } : {}) });
  };

  // The body (pid 1 in the UI): a clone of the user's repo that every fork descends from.
  const body = join(runDir, "body");
  const bodyForker = await pickForker(repo, runDir);
  await bodyForker.fork(repo, [body]);
  const baseSha = await initBase(body);
  const forker = o.forker ?? (await pickForker(body, join(runDir, "forks")));
  const engine = o.claudeCode ? "claude-code" : o.hosted ? "hosted" : "api";

  bus.emit({
    type: "run_start",
    runId: o.runId,
    task: o.task,
    testCmd: o.testCmd,
    forks: o.forks,
    rounds: o.rounds,
    model: o.claudeCode ? `claude-code${o.claudeCode.model ? ` (${o.claudeCode.model})` : ""}` : o.hosted ? o.hosted.label : o.model!.model,
    engine,
    effort: o.effort,
    mode: o.mode,
    repo,
    forker: forker.name,
    sandbox: o.sandbox,
    network: o.network,
  });

  // Scripts and setup files the test command runs are as much a part of the judge as the tests are.
  if (o.protectTestInfra !== false) {
    const extra = (await testInfraFiles(body, o.testCmd)).filter((f) => !matchesAny(f, protect));
    if (extra.length) {
      protect.push(...extra.map(literalRegExp));
      bus.emit({ type: "log", level: "info", msg: `Also read-only for forks, since the test command runs or loads them: ${extra.join(", ")}` });
    }
  }

  // The runs folder is denied by name: under ~ that changes nothing, outside ~ it keeps other forks and runs private.
  const specFor = (root: string, id: string): SandboxSpec => ({
    root,
    tmp: join(runDir, "tmp", id),
    network: o.network,
    gitWrite: false,
    disabled: !o.sandbox,
    denyRead: [runsDir],
  });

  // Baseline: how the suite does before any fork touches it.
  const base = await runSandboxed(o.testCmd, specFor(body, "body"), { timeoutMs: o.testTimeoutMs, maxOutput: o.maxOutput, signal: o.signal });
  const baseCounts = parseCounts(base.output);
  const baselineTotal = baseCounts.passed !== null && baseCounts.failed !== null ? baseCounts.passed + baseCounts.failed : null;
  const baseScore = base.timedOut || base.aborted ? 0 : score(base.code, baseCounts, null);
  bus.emit({
    type: "baseline",
    passed: baseCounts.passed,
    failed: baseCounts.failed,
    exitCode: base.timedOut || base.aborted ? null : base.code,
    score: baseScore,
    outputTail: tailOf(base.output),
  });
  if (interrupted()) {
    bus.emit({ type: "log", level: "error", msg: "Interrupted before any fork started." });
    return endEarly(false, 0);
  }
  const broken = brokenTestCommand(base, baseCounts, o.testTimeoutMs);
  if (broken) {
    bus.emit({ type: "log", level: "error", msg: `No forks started: ${broken}` });
    return endEarly(false, baseScore, broken);
  }
  if (base.timedOut) {
    bus.emit({ type: "log", level: "warn", msg: `The test command timed out on the unchanged repo (--test-timeout ${Math.round(o.testTimeoutMs / 1000)}s). Forks get the same limit, so only a fork that fixes the hang can pass.` });
  }
  if (baseScore === 1) {
    bus.emit({ type: "log", level: "warn", msg: "The test suite already passes. Nothing for the forks to do." });
    return endEarly(true, 1);
  }

  if (!o.claudeCode && !o.hosted && !o.model) throw new Error("no engine: pass a model client, claudeCode or hosted options");
  const system = systemPrompt({ bashTimeoutS: Math.round(o.bashTimeoutMs / 1000), engine });
  // Hosted runs share one credit balance: once a fork hits 402, nothing else starts.
  const credit: CreditGate = { exhausted: null };
  let creditLogged = false;
  // The balance before any fork runs, so the run can report what it was really charged (see chargedSince).
  const balanceBefore = o.hosted?.balance ? await o.hosted.balance(AbortSignal.timeout(15_000)).catch(() => null) : null;

  // Something that stops every fork at once: Ctrl-C, a rejected key, a disk about to fill up.
  let halted: string | null = null;
  let haltRound: ((why: string) => void) | null = null;
  const halt = (why: string, msg: string) => {
    if (halted) return;
    halted = why;
    bus.emit({ type: "log", level: "error", msg });
    haltRound?.(why);
  };
  const onInterrupt = () => halt("interrupted", "Interrupted: stopping every fork.");
  if (o.signal?.aborted) onInterrupt();
  o.signal?.addEventListener("abort", onInterrupt, { once: true });
  const free0 = await freeBytes(runDir);
  const diskFloor = o.diskFloorBytes ?? Math.min(1024 ** 3, free0 / 2);
  const checkDisk = async () => {
    const free = await freeBytes(runDir).catch(() => Number.POSITIVE_INFINITY);
    if (free < diskFloor) halt("disk nearly full", `Only ${fmtBytes(free)} left on the disk, so every fork was stopped before it fills up.`);
  };

  let parent: { id: string; dir: string; score: number; strategy: string; summary: string; tail: string; passed: number | null; failed: number | null } = {
    id: "body",
    dir: body,
    score: baseScore,
    strategy: "",
    summary: "",
    tail: "",
    passed: baseCounts.passed,
    failed: baseCounts.failed,
  };
  let overallBest: ForkRecord | null = null;
  let winner: ForkRecord | null = null;
  const losers: string[] = [];
  const staleStates: string[] = [];

  for (let round = 1; round <= o.rounds && !winner && !credit.exhausted && !halted; round++) {
    await checkDisk();
    if (halted) break;
    const ids = Array.from({ length: o.forks }, (_, i) => `${round}.${String(i + 1).padStart(2, "0")}`);
    const dirs = ids.map((id) => join(runDir, "forks", id));

    const workspaceBytes = await treeBytes(parent.dir);
    const freeBefore = await freeBytes(runDir);
    const clones = await forker.fork(parent.dir, dirs);
    const freeAfter = await freeBytes(runDir);
    bus.emit({
      type: "fork",
      round,
      parent: parent.id,
      forks: ids,
      msEach: clones.map((c) => Math.round(c.ms * 100) / 100),
      workspaceBytes,
      logicalBytes: workspaceBytes * ids.length,
      physicalBytes: Math.max(0, freeBefore - freeAfter),
      forker: forker.name,
    });

    const controllers = ids.map(() => new AbortController());
    const keys = o.claudeCode ? keyFiles() : []; // once per round, not once per fork
    const why: Array<"killed" | "timeout"> = ids.map(() => "killed");
    const state: Array<"running" | "judging" | "done"> = ids.map(() => "running");
    let raceWinner: ForkRecord | null = null;
    const stopOthers = (except: number, reason: string) =>
      ids.forEach((other, j) => {
        if (j !== except && state[j] !== "done" && !controllers[j]!.signal.aborted) {
          why[j] = "killed";
          controllers[j]!.abort();
          bus.emit({ type: "kill", fork: other, why: reason });
        }
      });
    haltRound = (reason) => stopOthers(-1, reason);
    const diskTimer = setInterval(() => void checkDisk(), 2000);

    const context =
      parent.id === "body"
        ? ""
        : `\nThis workspace continues from fork ${parent.id} (strategy: ${parent.strategy}), the best fork of the previous round. ` +
          `It got ${parent.passed ?? "?"} passing and ${parent.failed ?? "?"} failing, and its changes are already in your workspace.\n` +
          `Where it left off: ${parent.summary || "(no summary)"}\nTail of its last test run:\n${parent.tail}`;

    const records = await Promise.all(
      ids.map(async (id, i): Promise<ForkRecord | null> => {
        const strat = strategyFor(i + (round - 1) * o.forks);
        const ctl = controllers[i]!;
        bus.emit({ type: "fork_start", fork: id, round, parent: parent.id, strategy: strat.name, brief: strat.brief });
        const spec = specFor(dirs[i]!, id);
        const ws = new Workspace(spec, { bashTimeoutMs: o.bashTimeoutMs, maxOutput: o.maxOutput });
        const timer = setTimeout(() => {
          why[i] = "timeout";
          ctl.abort();
        }, o.forkTimeoutMs);

        const prompt = `Task: ${o.task}\nTest command: ${o.testCmd}\n\nYour strategy (${strat.name}): ${strat.brief}\n${context}`;
        const result = o.claudeCode
          ? await withSlot(apiSlots, () =>
              runClaudeCodeFork(
                {
                  id,
                  dir: dirs[i]!,
                  tmp: spec.tmp,
                  system,
                  prompt,
                  model: o.claudeCode!.model,
                  effort: o.effort,
                  maxTurns: o.maxTurns,
                  network: o.network,
                  signal: ctl.signal,
                  abortReason: () => why[i]!,
                  bus,
                  claudeBin: o.claudeCode!.bin,
                },
                claudeSettings({ dir: dirs[i]!, tmp: spec.tmp, network: o.network, keys }),
              ),
            )
          : o.hosted
            ? await runHostedFork({
                id,
                workspace: ws,
                client: o.hosted,
                system,
                prompt,
                maxTurns: o.maxTurns,
                signal: ctl.signal,
                abortReason: () => why[i]!,
                bus,
                apiSlots,
                credit,
              })
            : await runFork({
                id,
                workspace: ws,
                model: o.model!,
                system,
                prompt,
                maxTurns: o.maxTurns,
                signal: ctl.signal,
                abortReason: () => why[i]!,
                bus,
                apiSlots,
              });
        clearTimeout(timer);
        addCost(result);
        bus.emit({ type: "fork_done", fork: id, ...result });
        if (credit.exhausted && !creditLogged) {
          creditLogged = true;
          bus.emit({ type: "log", level: "error", msg: `Hosted credit ran out, so no more forks will start. ${credit.exhausted}` });
        }
        // A rejected key means every other fork fails the same way: stop them all rather than judge nothing.
        if (result.fatal) {
          state[i] = "done";
          halt("stopped", result.fatal);
          return null;
        }
        if (result.reason === "killed" || (ctl.signal.aborted && why[i] === "killed")) {
          state[i] = "done";
          return null;
        }

        state[i] = "judging";
        bus.emit({ type: "judging", fork: id });
        // A fork that ran out of time still gets judged, on a fresh signal.
        const judgeCtl = new AbortController();
        const forward = () => {
          if (why[i] === "killed") judgeCtl.abort();
        };
        ctl.signal.addEventListener("abort", forward);
        const v = await judge(
          spec,
          {
            testCmd: o.testCmd,
            baseSha,
            protect,
            testTimeoutMs: o.testTimeoutMs,
            maxOutput: o.maxOutput,
            baselineTotal,
            bodyDir: body,
            forker,
            stateDir: join(runDir, "state", id),
            tmpDir: join(runDir, "tmp", `judge-${id}`),
            network: o.network,
            sandbox: o.sandbox,
            denyRead: [runsDir],
          },
          judgeCtl.signal,
        ).catch((err: Error) => {
          bus.emit({ type: "log", level: "error", msg: `judging ${id} failed: ${err.message}` });
          return null;
        });
        ctl.signal.removeEventListener("abort", forward);
        state[i] = "done";
        if (judgeCtl.signal.aborted || !v) {
          staleStates.push(join(runDir, "state", id));
          return null;
        }

        bus.emit({
          type: "judge",
          fork: id,
          passed: v.passed,
          failed: v.failed,
          exitCode: v.exitCode,
          score: v.score,
          diffLines: v.diffLines,
          filesChanged: v.filesChanged,
          tampered: v.tampered,
          outputTail: tailOf(v.output),
        });
        if (!v.stateDir) {
          return null;
        }
        const rec: ForkRecord = {
          id,
          dir: dirs[i]!,
          stateDir: v.stateDir,
          strategy: strat.name,
          score: v.score,
          passed: v.passed,
          failed: v.failed,
          diffLines: v.diffLines,
          filesChanged: v.filesChanged,
          patch: v.patch,
          summary: result.summary,
          tail: tailOf(v.output),
          finishedAt: performance.now(),
        };

        if (o.mode === "race" && v.score === 1 && !raceWinner && !halted) {
          raceWinner = rec;
          stopOthers(i, `${id} passed first`);
        }
        return rec;
      }),
    );
    clearInterval(diskTimer);
    haltRound = null;

    let roundBest: ForkRecord | null = raceWinner;
    if (!roundBest) for (const r of records) if (r && better(r, roundBest)) roundBest = r;
    for (const r of records) if (r && r !== roundBest) losers.push(r.dir, r.stateDir);
    ids.forEach((_, i) => {
      if (!records[i]) losers.push(dirs[i]!, join(runDir, "state", ids[i]!));
    });
    bus.emit({ type: "round_end", round, best: roundBest?.id ?? null, bestScore: roundBest?.score ?? 0 });

    if (roundBest && better(roundBest, overallBest)) overallBest = roundBest;
    if (roundBest && roundBest.score === 1) winner = roundBest;
    else if (roundBest && roundBest.score > parent.score) {
      parent = {
        id: roundBest.id,
        dir: roundBest.stateDir,
        score: roundBest.score,
        strategy: roundBest.strategy,
        summary: roundBest.summary,
        tail: roundBest.tail,
        passed: roundBest.passed,
        failed: roundBest.failed,
      };
    }
  }
  o.signal?.removeEventListener("abort", onInterrupt);

  // A "best" fork is only worth keeping if it did better than the repo did on its own.
  const improved = overallBest && overallBest.score > baseScore ? overallBest : null;
  let patchPath: string | null = null;
  let applied = false;
  const final = winner ?? improved;
  if (final && final.patch.trim()) {
    patchPath = join(runDir, winner ? "winner.patch" : "best.patch");
    await writeFile(patchPath, final.patch);
  }
  if (winner) {
    bus.emit({
      type: "winner",
      fork: winner.id,
      round: Number(winner.id.split(".")[0]),
      score: winner.score,
      diffLines: winner.diffLines,
      filesChanged: winner.filesChanged,
      patch: winner.patch,
      summary: winner.summary,
    });
    if (o.apply && patchPath && interrupted()) {
      bus.emit({ type: "log", level: "warn", msg: `Not applied, since the run was interrupted. The patch is saved at ${patchPath}.` });
    } else if (o.apply && patchPath) {
      const r = await applyPatch(repo, patchPath);
      applied = r.ok;
      if (!r.ok) bus.emit({ type: "log", level: "error", msg: `Couldn't apply the patch to ${repo}: ${r.error}. It's saved at ${patchPath}.` });
    }
  } else if (!halted) {
    const baseline = baselineTotal !== null ? `${baseCounts.passed}/${baselineTotal} passing` : `${Math.round(baseScore * 100)}%`;
    bus.emit({
      type: "log",
      level: "warn",
      msg: improved
        ? `No fork passed the whole suite. Best was ${improved.id} (${improved.strategy}) at ${Math.round(improved.score * 100)}%, up from ${baseline}.`
        : overallBest
          ? `No fork passed the whole suite or did better than the baseline (${baseline}).`
          : "No fork produced a result.",
    });
  }

  if (!o.keepForks) {
    const keep = new Set([final?.dir, final?.stateDir]);
    await Promise.all([...losers, ...staleStates].filter((d) => !keep.has(d)).map((d) => rm(d, { recursive: true, force: true })));
  }
  await rm(join(runDir, "tmp"), { recursive: true, force: true });

  // Hosted turns the run hung up on were estimated here. Once the gateway has settled them, the balance says
  // what they really cost; if it can't be read or doesn't add up, the estimate stands and is marked as one.
  if (costUsd !== null && estimatedUsd > 0 && balanceBefore !== null && !interrupted()) {
    const charged = await chargedSince(o.hosted!, balanceBefore, { usd: costUsd, estimatedUsd }, { signal: o.signal });
    if (charged !== null) {
      costUsd = charged;
      estimatedUsd = 0;
    }
  }

  bus.emit({
    type: "run_end",
    ok: !!winner,
    ms: Math.round(performance.now() - t0),
    costUsd,
    ...(costUsd !== null && estimatedUsd > 0 ? { costApprox: true } : {}),
    applied,
    patchPath,
    best: final?.id ?? null,
    bestScore: final?.score ?? 0,
    ...(interrupted() ? { interrupted: true } : {}),
  });
  return summary({
    ok: !!winner,
    winner: winner?.id ?? null,
    best: final?.id ?? null,
    bestScore: final?.score ?? 0,
    patchPath,
    applied,
    ...(halted && halted !== "interrupted" ? { error: halted } : {}),
  });
}

export { DEFAULT_PROTECT };
