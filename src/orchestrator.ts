import { realpathSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelClient, runHead, systemPrompt } from "./agent.js";
import { claudeSettings, runClaudeCodeHead } from "./engines/claude-code.js";
import type { EventBus } from "./events.js";
import { type Forker, pickForker } from "./fork/forker.js";
import { DEFAULT_PROTECT, judge, parseCounts, score } from "./judge.js";
import { type SandboxSpec, runSandboxed } from "./sandbox.js";
import { strategyFor } from "./strategies.js";
import { Workspace } from "./tools.js";
import { Semaphore, exec, freeBytes, globToRegExp, treeBytes } from "./util.js";

export interface RunOptions {
  runId: string;
  repo: string;
  task: string;
  testCmd: string;
  heads: number;
  rounds: number;
  mode: "race" | "best";
  /** API engine: talks to the Messages API with an API key. */
  model?: ModelClient;
  /** Claude Code engine: drives `claude -p` on the user's Claude Code login (subscription). */
  claudeCode?: { model?: string; bin?: string };
  effort: string;
  maxTurns: number;
  headTimeoutMs: number;
  bashTimeoutMs: number;
  testTimeoutMs: number;
  maxOutput: number;
  network: boolean;
  sandbox: boolean;
  protect: string[];
  apply: boolean;
  keepHeads: boolean;
  runsDir: string;
  concurrency: number;
  forker?: Forker;
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
  error?: string;
}

interface HeadRecord {
  id: string;
  dir: string;
  /** body + this head's patch, verified by the judge. Next rounds grow from here. */
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
  "-c", "user.name=Forkbomb",
  "-c", "user.email=forkbomb@localhost",
];

/**
 * Snapshot the body as a commit every head shares. Runs before any head
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
  const commit = await exec("git", [...GIT_TRUSTED, "-C", dir, "commit", "-q", "--no-verify", "--allow-empty", "-m", "forkbomb: base"], { env });
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

function better(a: HeadRecord, b: HeadRecord | null): boolean {
  if (!b) return true;
  if (a.score !== b.score) return a.score > b.score;
  if (a.diffLines !== b.diffLines) return a.diffLines < b.diffLines;
  return a.finishedAt < b.finishedAt;
}

export async function runForkbomb(o: RunOptions, bus: EventBus): Promise<RunSummary> {
  const t0 = performance.now();
  const repo = realpathSync(o.repo);
  const runDir = join(realpathSync(o.runsDir), o.runId);
  await mkdir(join(runDir, "heads"), { recursive: true });
  await mkdir(join(runDir, "state"), { recursive: true });
  await mkdir(join(runDir, "tmp"), { recursive: true });

  const protect = o.protect.map(globToRegExp);
  const apiSlots = new Semaphore(o.concurrency);
  let costUsd: number | null = 0;
  const addCost = (c: number | null) => {
    costUsd = costUsd === null || c === null ? null : costUsd + c;
  };
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
    ...extra,
  });

  // The body: a clone of the user's repo that every head descends from.
  const body = join(runDir, "body");
  const bodyForker = await pickForker(repo, runDir);
  await bodyForker.fork(repo, [body]);
  const baseSha = await initBase(body);
  const forker = o.forker ?? (await pickForker(body, join(runDir, "heads")));

  bus.emit({
    type: "run_start",
    runId: o.runId,
    task: o.task,
    testCmd: o.testCmd,
    heads: o.heads,
    rounds: o.rounds,
    model: o.claudeCode ? `claude-code${o.claudeCode.model ? ` (${o.claudeCode.model})` : ""}` : o.model!.model,
    engine: o.claudeCode ? "claude-code" : "api",
    effort: o.effort,
    mode: o.mode,
    repo,
    forker: forker.name,
    sandbox: o.sandbox,
    network: o.network,
  });

  const specFor = (root: string, id: string): SandboxSpec => ({
    root,
    tmp: join(runDir, "tmp", id),
    network: o.network,
    gitWrite: false,
    disabled: !o.sandbox,
  });

  // Baseline: how the suite does before any head touches it.
  const base = await runSandboxed(o.testCmd, specFor(body, "body"), { timeoutMs: o.testTimeoutMs, maxOutput: o.maxOutput });
  const baseCounts = parseCounts(base.output);
  const baselineTotal = baseCounts.passed !== null && baseCounts.failed !== null ? baseCounts.passed + baseCounts.failed : null;
  const baseScore = base.timedOut ? 0 : score(base.code, baseCounts, null);
  bus.emit({
    type: "baseline",
    passed: baseCounts.passed,
    failed: baseCounts.failed,
    exitCode: base.timedOut ? null : base.code,
    score: baseScore,
    outputTail: tailOf(base.output),
  });
  if (baseScore === 1) {
    bus.emit({ type: "log", level: "warn", msg: "The test suite already passes. Nothing for the heads to do." });
    bus.emit({ type: "run_end", ok: true, ms: Math.round(performance.now() - t0), costUsd: 0, applied: false, patchPath: null, best: null, bestScore: 1 });
    return summary({ ok: true, bestScore: 1 });
  }

  if (!o.claudeCode && !o.model) throw new Error("no engine: pass a model client or claudeCode options");
  const system = systemPrompt({ bashTimeoutS: Math.round(o.bashTimeoutMs / 1000), engine: o.claudeCode ? "claude-code" : "api" });
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
  let overallBest: HeadRecord | null = null;
  let winner: HeadRecord | null = null;
  const losers: string[] = [];
  const staleStates: string[] = [];

  for (let round = 1; round <= o.rounds && !winner; round++) {
    const ids = Array.from({ length: o.heads }, (_, i) => `${round}.${String(i + 1).padStart(2, "0")}`);
    const dirs = ids.map((id) => join(runDir, "heads", id));

    const workspaceBytes = await treeBytes(parent.dir);
    const free0 = await freeBytes(runDir);
    const forks = await forker.fork(parent.dir, dirs);
    const free1 = await freeBytes(runDir);
    bus.emit({
      type: "fork",
      round,
      parent: parent.id,
      heads: ids,
      msEach: forks.map((f) => Math.round(f.ms * 100) / 100),
      workspaceBytes,
      logicalBytes: workspaceBytes * ids.length,
      physicalBytes: Math.max(0, free0 - free1),
      forker: forker.name,
    });

    const controllers = ids.map(() => new AbortController());
    const why: Array<"severed" | "timeout"> = ids.map(() => "severed");
    const state: Array<"running" | "judging" | "done"> = ids.map(() => "running");
    let raceWinner: HeadRecord | null = null;

    const context =
      parent.id === "body"
        ? ""
        : `\nThis workspace continues from head ${parent.id} (strategy: ${parent.strategy}), the best head of the previous round. ` +
          `It got ${parent.passed ?? "?"} passing and ${parent.failed ?? "?"} failing, and its changes are already in your workspace.\n` +
          `Where it left off: ${parent.summary || "(no summary)"}\nTail of its last test run:\n${parent.tail}`;

    const records = await Promise.all(
      ids.map(async (id, i): Promise<HeadRecord | null> => {
        const strat = strategyFor(i + (round - 1) * o.heads);
        const ctl = controllers[i]!;
        bus.emit({ type: "head_start", head: id, round, parent: parent.id, strategy: strat.name, brief: strat.brief });
        const spec = specFor(dirs[i]!, id);
        const ws = new Workspace(spec, { bashTimeoutMs: o.bashTimeoutMs, maxOutput: o.maxOutput });
        const timer = setTimeout(() => {
          why[i] = "timeout";
          ctl.abort();
        }, o.headTimeoutMs);

        const prompt = `Task: ${o.task}\nTest command: ${o.testCmd}\n\nYour strategy (${strat.name}): ${strat.brief}\n${context}`;
        const result = o.claudeCode
          ? await withSlot(apiSlots, () =>
              runClaudeCodeHead(
                {
                  id,
                  dir: dirs[i]!,
                  tmp: spec.tmp,
                  system,
                  prompt,
                  model: o.claudeCode!.model,
                  effort: o.effort,
                  network: o.network,
                  signal: ctl.signal,
                  abortReason: () => why[i]!,
                  bus,
                  claudeBin: o.claudeCode!.bin,
                },
                claudeSettings({ dir: dirs[i]!, tmp: spec.tmp, network: o.network }),
              ),
            )
          : await runHead({
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
        addCost(result.costUsd);
        bus.emit({ type: "head_done", head: id, ...result });

        if (result.reason === "severed") {
          state[i] = "done";
          return null;
        }

        state[i] = "judging";
        bus.emit({ type: "judging", head: id });
        // A head that ran out of time still gets judged, on a fresh signal.
        const judgeCtl = new AbortController();
        const forward = () => {
          if (why[i] === "severed") judgeCtl.abort();
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
          head: id,
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
        const rec: HeadRecord = {
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

        if (o.mode === "race" && v.score === 1 && !raceWinner) {
          raceWinner = rec;
          ids.forEach((other, j) => {
            if (j !== i && state[j] !== "done") {
              why[j] = "severed";
              controllers[j]!.abort();
              bus.emit({ type: "sever", head: other, why: `${id} passed first` });
            }
          });
        }
        return rec;
      }),
    );

    let roundBest: HeadRecord | null = raceWinner;
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

  let patchPath: string | null = null;
  let applied = false;
  const final = winner ?? overallBest;
  if (final && final.patch.trim()) {
    patchPath = join(runDir, winner ? "winner.patch" : "best.patch");
    await writeFile(patchPath, final.patch);
  }
  if (winner) {
    bus.emit({
      type: "winner",
      head: winner.id,
      round: Number(winner.id.split(".")[0]),
      score: winner.score,
      diffLines: winner.diffLines,
      filesChanged: winner.filesChanged,
      patch: winner.patch,
      summary: winner.summary,
    });
    if (o.apply && patchPath) {
      const r = await applyPatch(repo, patchPath);
      applied = r.ok;
      if (!r.ok) bus.emit({ type: "log", level: "error", msg: `Couldn't apply the patch to ${repo}: ${r.error}. It's saved at ${patchPath}.` });
    }
  } else {
    bus.emit({
      type: "log",
      level: "warn",
      msg: overallBest
        ? `No head passed the whole suite. Best was ${overallBest.id} (${overallBest.strategy}) at ${Math.round(overallBest.score * 100)}%.`
        : "No head produced a result.",
    });
  }

  if (!o.keepHeads) {
    const keep = new Set([final?.dir, final?.stateDir]);
    await Promise.all([...losers, ...staleStates].filter((d) => !keep.has(d)).map((d) => rm(d, { recursive: true, force: true })));
  }
  await rm(join(runDir, "tmp"), { recursive: true, force: true });

  bus.emit({
    type: "run_end",
    ok: !!winner,
    ms: Math.round(performance.now() - t0),
    costUsd,
    applied,
    patchPath,
    best: final?.id ?? null,
    bestScore: final?.score ?? 0,
  });
  return summary({
    ok: !!winner,
    winner: winner?.id ?? null,
    best: final?.id ?? null,
    bestScore: final?.score ?? 0,
    patchPath,
    applied,
  });
}

export { DEFAULT_PROTECT };
