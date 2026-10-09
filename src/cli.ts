#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { constants, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModel, type Effort } from "./agent.js";
import { bench, benchTable } from "./bench.js";
import { BRAND, HOME_ENV, HOSTED_KEY_ENV, HOSTED_URL_ENV } from "./brand.js";
import { EventBus, type Stamped, parseEventLog, scrubPaths } from "./events.js";
import { type CanaryResult, cachedCanaryPass, runCanary } from "./engines/canary.js";
import { shortVersion } from "./engines/claude-code.js";
import { HostedClient, HostedError, formatCredits, hostedSettings } from "./engines/hosted.js";
import { canClone } from "./fork/forker.js";
import { DEFAULT_PROTECT } from "./judge.js";
import { runRace } from "./orchestrator.js";
import { killAll } from "./procs.js";
import { runSandboxed } from "./sandbox.js";
import { serve } from "./server.js";
import { PKG_ROOT, appHome, exec, fmtBytes, makeRunDir, tildify } from "./util.js";

const CLI = BRAND.slug;
/** Where the CLI keeps its files unless <SLUG>_HOME moves them. */
const DEFAULT_HOME = `~/.${BRAND.slug}`;
/** Where they actually are on this run, as people type it. */
const HOME = tildify(appHome());

const USAGE = {
  run: `${CLI} run [repo] --task "..." --test "npm test" [options]`,
  bench: `${CLI} bench [dir] [--forks 16] [--no-copy] [--json]`,
  replay: `${CLI} replay <run-dir | events.jsonl> [--port 4317] [--no-open]`,
  export: `${CLI} export <run-dir> <out-dir>`,
  doctor: `${CLI} doctor`,
  credits: `${CLI} credits [--json]   hosted credit balance and pricing`,
  canary: `${CLI} canary [--claude-bin PATH] [--model ID]\n                            prove Claude Code forks can't escape (runs a tiny session)`,
} as const;
type Command = keyof typeof USAGE;

const RUN_OPTIONS = `run options
  --forks N           forks per round (default 8)
  --rounds N          rounds; each round forks from the best fork so far (default 2)
  --mode race|best    race: first full pass exits 0 and the rest are killed (default)
                      best: let every fork finish, keep the smallest passing diff
  --engine NAME       claude-code: run forks through Claude Code on your
                      Claude subscription (default)
                      api: call the Anthropic API with an API key
                      hosted: run forks on hosted compute, paid with credit
                      from burning $${BRAND.ticker}
  --model ID          model for the forks (api default: claude-opus-5-5;
                      claude-code default: your Claude Code default)
  --effort LEVEL      low | medium | high | xhigh | max (default medium)
  --claude-bin PATH   Claude Code binary for --engine claude-code (default: claude on PATH)
  --max-turns N       tool-use turns per fork (default 30)
  --fork-timeout S    seconds per fork (default 600)
  --bash-timeout S    seconds per shell command (default 120)
  --test-timeout S    seconds per test run (default 300)
  --concurrency N     max forks talking to the API at once (default 8)
  --protect GLOB      extra read-only path for forks (repeatable)
  --no-default-protect  don't protect test files, test config, or the scripts
                      and setup files the test command runs
  --apply             apply the winning patch to the repo
  --keep-forks        keep killed forks' clones on disk
  --network           let forks reach the network (default: loopback only)
  --no-sandbox        run forks without the macOS sandbox (not recommended)
  --ui                open the live process tree in your browser
  --port N            port for --ui / replay (default 4317)
  --no-open           don't open a browser for --ui
  --runs-dir DIR      where runs live (default ${HOME}/runs)
  -v, --verbose       print every tool call
  Ctrl-C stops every fork, cleans up and exits 130.`;

const CREDENTIALS = `Credentials: with --engine claude-code, whatever Claude Code is logged in with
(claude auth login). With --engine api, ANTHROPIC_API_KEY in the environment or
in ${HOME}/.env. With --engine hosted, ${HOSTED_KEY_ENV} in the environment or in
${HOME}/.env (get a key and top up at ${BRAND.site}/app; ${HOSTED_URL_ENV}
overrides the gateway, default ${BRAND.site}/api/v1). Keys stay on your machine:
the Anthropic key goes only to Anthropic, the hosted key only to the hosted
gateway, and no key ever reaches a fork. Self-hosting stays free.
${HOME_ENV} moves ${DEFAULT_HOME}${HOME === DEFAULT_HOME ? "" : ` (here: ${HOME})`}.`;

const HELP = `${CLI}: fork a coding agent into N sandboxed copies of your repo. They race, the tests judge, the losers get killed and one exits 0.

Usage
  ${Object.values(USAGE).join("\n  ")}
  -h, --help                this help; ${CLI} <command> --help for one command

${RUN_OPTIONS}

${CREDENTIALS}`;

/** What `<command> --help` prints. */
const COMMAND_HELP: Record<Command, string> = {
  run: `Usage\n  ${USAGE.run}\n\n${RUN_OPTIONS}\n\n${CREDENTIALS}`,
  bench: `Usage\n  ${USAGE.bench}\n\nFork a directory with clonefile and with a plain copy, and report both.\n  --forks N    forks to make (1-64, default 16)\n  --no-copy    skip the plain-copy baseline\n  --json       print the rows as JSON`,
  replay: `Usage\n  ${USAGE.replay}\n\nPlay a recorded run back in the browser.\n  --port N     port to serve on (default 4317, the next free one if taken)\n  --no-open    don't open a browser`,
  export: `Usage\n  ${USAGE.export}\n\nWrite a static replay of a run you can host anywhere. Local paths (your home\nfolder, the run folder, the repo's location) are replaced before anything is written.`,
  doctor: `Usage\n  ${USAGE.doctor}\n\nCheck this machine: macOS, Node, APFS clones, clang, the sandbox (writes and\nnetwork), Claude Code and keys. Exits 1 if any check fails.`,
  credits: `Usage\n  ${USAGE.credits}\n\nShow the hosted workspace's credit and pricing (needs ${HOSTED_KEY_ENV}).\n  --json       print the raw /me response`,
  canary: `Usage\n  ${USAGE.canary}\n\n  --claude-bin PATH   Claude Code binary (default: claude on PATH)\n  --model ID          model for the canary session (default: haiku)`,
};

/** <home>/.env as people type it, for messages about where keys go. */
const ENV_FILE = `${HOME}/.env`;

/** Fill unset env vars from <home>/.env. Skips the read when every wanted var is already set. */
function loadEnvFile(...want: string[]): void {
  if (want.length && want.every((k) => process.env[k])) return;
  const f = join(appHome(), ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function fail(msg: string): never {
  console.error(`${CLI}: ${msg}`);
  process.exit(1);
}

/** Print a command's own help and stop. */
function usage(cmd: Command): never {
  console.log(COMMAND_HELP[cmd]);
  process.exit(0);
}

function openBrowser(url: string): void {
  spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
}

/** Inside `parent` (or equal to it), after resolving symlinks where the paths exist. */
function within(child: string, parent: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = relative(real(parent), real(child));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** The repo copy every fork descends from is "body" in events; people see it as pid 1. */
const pid = (id: string) => (id === "body" ? "pid 1" : id);

/** Compact terminal narration of a run. */
function narrate(e: Stamped, verbose: boolean): void {
  const t = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
  const say = (s: string) => console.log(`${t}  ${s}`);
  switch (e.type) {
    case "run_start":
      say(`run ${e.runId}: ${e.forks} forks × ${e.rounds} rounds · ${e.model} (${e.effort}) · ${e.mode} · sandbox ${e.sandbox ? "on" : "OFF"}${e.engine === "claude-code" ? " · on your Claude subscription" : e.engine === "hosted" ? " · on hosted credit" : ""}`);
      break;
    case "baseline":
      say(`baseline: ${e.passed ?? "?"} passing, ${e.failed ?? "?"} failing (${e.exitCode === null ? "no exit code" : `exit ${e.exitCode}`})`);
      break;
    case "fork": {
      const avg = e.msEach.reduce((a, b) => a + b, 0) / Math.max(1, e.msEach.length);
      say(`fork  ${e.forks.length} × ${pid(e.parent)} in ${avg.toFixed(2)} ms each via ${e.forker} · ${fmtBytes(e.logicalBytes)} logical, ${fmtBytes(e.physicalBytes ?? 0)} physical`);
      break;
    }
    case "fork_start":
      if (verbose) say(`  ${e.fork} ${e.strategy}`);
      break;
    case "tool":
      if (verbose) say(`  ${e.fork} ${e.tool === "bash" ? "$" : "✎"} ${e.summary}`);
      break;
    case "fork_done": {
      const cost = e.costUsd != null ? ` · ${e.costEstimatedUsd ? "~" : ""}$${e.costUsd.toFixed(3)}` : "";
      if (e.reason !== "killed") say(`  ${e.fork} done: ${e.reason} after ${e.turns} turns${cost}${e.error ? ` · ${e.error}` : ""}`);
      break;
    }
    case "judge": {
      const total = e.passed != null && e.failed != null ? e.passed + e.failed : null;
      const mark = e.score === 1 ? "PASS" : "fail";
      say(`  ${e.fork} ${mark} ${total != null ? `${e.passed}/${total}` : `${Math.round(e.score * 100)}%`} · ${e.diffLines} lines${e.tampered.length ? ` · reverted test edits: ${e.tampered.join(", ")}` : ""}`);
      break;
    }
    case "kill":
      say(`  ${e.fork} killed (${e.why})`);
      break;
    case "round_end":
      say(`round ${e.round}: best ${e.best ?? "none"} at ${Math.round(e.bestScore * 100)}%`);
      break;
    case "winner":
      say(`EXIT 0 ${e.fork}: ${e.diffLines} lines in ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}. ${e.summary.split("\n")[0] ?? ""}`);
      break;
    case "run_end": {
      const cost = e.costUsd != null ? ` · ${e.costApprox ? "about " : ""}$${e.costUsd.toFixed(2)}` : "";
      say(`${e.interrupted ? "interrupted after" : "done in"} ${(e.ms / 1000).toFixed(1)}s${cost}${e.patchPath ? ` · patch: ${tildify(e.patchPath)}` : ""}${e.applied ? " · applied" : ""}`);
      break;
    }
    case "log":
      say(`${e.level === "info" ? "" : `${e.level}: `}${e.msg}`);
      break;
  }
}

/** The exit status a shell gives a process killed by `sig`: 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP. */
const signalExit = (sig: NodeJS.Signals) => 128 + (constants.signals[sig] ?? 2);

async function cmdRun(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      test: { type: "string" },
      forks: { type: "string", default: "8" },
      rounds: { type: "string", default: "2" },
      mode: { type: "string", default: "race" },
      engine: { type: "string", default: "claude-code" },
      model: { type: "string" },
      "claude-bin": { type: "string" },
      effort: { type: "string", default: "medium" },
      "max-turns": { type: "string", default: "30" },
      "fork-timeout": { type: "string", default: "600" },
      "bash-timeout": { type: "string", default: "120" },
      "test-timeout": { type: "string", default: "300" },
      concurrency: { type: "string", default: "8" },
      protect: { type: "string", multiple: true, default: [] },
      "no-default-protect": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "keep-forks": { type: "boolean", default: false },
      network: { type: "boolean", default: false },
      "no-sandbox": { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      port: { type: "string", default: "4317" },
      "runs-dir": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage("run");

  // Every option is checked before anything starts: no canary, no run folder, no network call for a typo.
  const repo = resolve(positionals[0] ?? ".");
  if (!values.task) fail("--task is required");
  if (!values.test) fail("--test is required (the command that decides who wins)");
  if (!(await stat(repo).catch(() => null))?.isDirectory()) fail(`not a directory: ${repo}`);
  const int = (k: string, v: string | undefined, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(`--${k} must be between ${min} and ${max}`);
    return n;
  };
  const forks = int("forks", values.forks, 1, 64);
  const rounds = int("rounds", values.rounds, 1, 10);
  const maxTurns = int("max-turns", values["max-turns"], 1, 500);
  const forkTimeoutMs = int("fork-timeout", values["fork-timeout"], 10, 86_400) * 1000;
  const bashTimeoutMs = int("bash-timeout", values["bash-timeout"], 1, 3600) * 1000;
  const testTimeoutMs = int("test-timeout", values["test-timeout"], 1, 7200) * 1000;
  const concurrency = int("concurrency", values.concurrency, 1, 64);
  const port = int("port", values.port, 1, 65_535);
  const mode = values.mode === "best" ? "best" : values.mode === "race" ? "race" : fail("--mode must be race or best");
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  if (!efforts.includes(values.effort!)) fail(`--effort must be one of ${efforts.join(", ")}`);
  const engine =
    values.engine === "api" || values.engine === "claude-code" || values.engine === "hosted"
      ? values.engine
      : fail("--engine must be claude-code, api or hosted");
  if (engine === "claude-code" && values.network) fail("--network isn't supported with --engine claude-code yet.");
  const runsDir = resolve(values["runs-dir"] ?? join(appHome(), "runs"));
  if (within(runsDir, repo)) fail("--runs-dir can't be inside the repo");
  if (within(repo, runsDir)) fail("the repo can't be inside the runs folder");
  if (values["no-sandbox"]) console.warn(`${CLI}: WARNING: --no-sandbox lets forks write anywhere your user can.`);
  if (process.platform !== "darwin" && !values["no-sandbox"]) fail("the sandbox needs macOS. Use --no-sandbox at your own risk.");

  // Ctrl-C, kill or a closed terminal: stop every fork and the commands it started, record the run as
  // interrupted, clean up and exit 128+signal. A second Ctrl-C (or 5 s) kills whatever is left at once.
  const interrupt = new AbortController();
  let bus: EventBus | null = null;
  let runDir: string | null = null;
  let raceExit: number | null = null;
  let stopCode = signalExit("SIGINT");
  const onSignal = (sig: NodeJS.Signals) => {
    const code = signalExit(sig);
    if (raceExit !== null) process.exit(raceExit); // the race is over; --ui was only keeping the view up
    if (interrupt.signal.aborted || !bus) {
      killAll("SIGKILL");
      process.exit(code);
    }
    stopCode = code;
    console.error(`\n${CLI}: ${sig === "SIGINT" ? "interrupted" : `got ${sig}`}: stopping every fork… (Ctrl-C again to force)`);
    interrupt.abort();
    setTimeout(() => {
      killAll("SIGKILL");
      if (bus && !bus.history.some((e) => e.type === "run_end")) {
        bus.emit({ type: "run_end", ok: false, ms: bus.history.at(-1)?.t ?? 0, costUsd: null, applied: false, patchPath: null, best: null, bestScore: 0, interrupted: true });
      }
      if (runDir) void rm(join(runDir, "tmp"), { recursive: true, force: true }).finally(() => process.exit(code));
      else process.exit(code);
    }, 5000);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, onSignal);

  let hosted: HostedClient | null = null;
  if (engine === "api") {
    loadEnvFile("ANTHROPIC_API_KEY");
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      fail(`no API key. Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in ${ENV_FILE}. Or use --engine claude-code to run on your Claude subscription.`);
    }
    // One free call, so a wrong key fails here instead of in every fork.
    try {
      await new Anthropic({ maxRetries: 1, timeout: 15_000 }).models.list({ limit: 1 });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        fail(`the Anthropic API rejected your key (${e.status}). Check ANTHROPIC_API_KEY (environment or ${ENV_FILE}).`);
      }
      console.warn(`${CLI}: couldn't check the API key first (${(e as Error).message}); starting anyway.`);
    }
  } else if (engine === "hosted") {
    hosted = hostedClient();
    if (values.model) console.warn(`${CLI}: --model is ignored with --engine hosted; the gateway picks the model.`);
    // Check the key and the balance before forking anything.
    const me = await hosted.me(AbortSignal.timeout(15_000)).catch((e: Error) => fail(e.message));
    if (me.credits.balanceMicroUsd <= 0) fail(`no hosted credit left. Burn $${BRAND.ticker} to top up at ${hosted.topUpUrl}`);
    console.log(`${CLI}: hosted credit $${me.credits.balanceUsd.toFixed(4)} · model ${me.pricing.model}`);
  } else {
    const bin = values["claude-bin"] ?? "claude";
    const st = await exec(bin, ["auth", "status"]).catch(() => null);
    if (!st) fail("Claude Code isn't installed (no `claude` on PATH). Install it, or use --engine api.");
    if (/"loggedIn":\s*false/.test(st.stdout)) fail("Claude Code isn't logged in. Run `claude auth login` with your Claude subscription, then try again.");
    const version = (await exec(bin, ["--version"])).stdout.trim();
    if (!cachedCanaryPass(version)) {
      console.log(`${CLI}: first run with Claude Code ${shortVersion(version)}: checking that forks are sealed in (about a minute)…`);
      const c = await runCanary({ bin });
      printCanary(c);
      if (!c.ok) fail(c.inconclusive ? "the isolation check was inconclusive, so no forks were started. See above." : "isolation check failed, so no forks were started. See above.");
    }
  }

  await mkdir(runsDir, { recursive: true });
  const id = await makeRunDir(runsDir);
  runDir = join(runsDir, id);
  bus = new EventBus(join(runDir, "events.jsonl"));
  const verbose = values.verbose!;
  bus.on((e) => narrate(e, verbose));

  let server: Awaited<ReturnType<typeof serve>> | null = null;
  if (values.ui) {
    server = await serve({ live: bus }, port);
    console.log(`${CLI}: live view at ${server.url}`);
    if (!values["no-open"]) openBrowser(server.url);
  }

  const result = await runRace(
    {
      runId: id,
      repo,
      task: values.task,
      testCmd: values.test,
      forks,
      rounds,
      mode,
      ...(engine === "api"
        ? { model: new AnthropicModel(new Anthropic({ maxRetries: 4 }), values.model ?? "claude-opus-5-5", values.effort as Effort) }
        : hosted
          ? { hosted }
          : { claudeCode: { model: values.model, bin: values["claude-bin"] } }),
      effort: values.effort!,
      maxTurns,
      forkTimeoutMs,
      bashTimeoutMs,
      testTimeoutMs,
      maxOutput: 12_000,
      network: values.network!,
      sandbox: !values["no-sandbox"],
      protect: [...(values["no-default-protect"] ? [] : DEFAULT_PROTECT), ...(values.protect ?? [])],
      protectTestInfra: !values["no-default-protect"],
      apply: values.apply!,
      keepForks: values["keep-forks"]!,
      runsDir,
      concurrency,
      signal: interrupt.signal,
    },
    bus,
  ).catch((e: Error) => {
    bus!.emit({ type: "log", level: "error", msg: e.message });
    return null;
  });

  console.log(`${CLI}: run saved in ${tildify(runDir)}`);
  if (interrupt.signal.aborted) {
    killAll("SIGKILL");
    process.exit(stopCode);
  }
  raceExit = result?.ok ? 0 : 1;
  if (server) {
    // Kept for when the view is closed: Ctrl-C then exits with the race's own status.
    process.exitCode = raceExit;
    console.log(`${CLI}: ${result?.ok ? "a fork passed (exit 0)" : "no fork passed (exit 1)"}. The view stays up at ${server.url}; Ctrl-C to quit with that status.`);
  } else process.exit(raceExit);
}

/** A run's events, checked line by line; exits with the first problem rather than replaying part of a run. */
async function loadEvents(target: string): Promise<{ events: Stamped[]; file: string }> {
  const st = await stat(target).catch(() => null);
  if (!st) fail(`no such run: ${target}`);
  const file = st.isDirectory() ? join(target, "events.jsonl") : target;
  try {
    return { events: parseEventLog(await readFile(file, "utf8")), file };
  } catch (e) {
    fail(`can't read ${file}: ${(e as Error).message}`);
  }
}

async function cmdReplay(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4317" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage("replay");
  if (!positionals[0]) fail(`usage: ${USAGE.replay}`);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("--port must be between 1 and 65535");
  const { events } = await loadEvents(resolve(positionals[0]));
  const { url } = await serve({ replay: events }, port);
  console.log(`${CLI}: replaying ${events.length} events at ${url}. Ctrl-C to quit.`);
  if (!values["no-open"]) openBrowser(url);
}

/** A static, self-contained replay you can host anywhere (Vercel, GitHub Pages), with this machine's paths taken out. */
async function cmdExport(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h", default: false } } });
  if (values.help) usage("export");
  const [src, out] = positionals;
  if (!src || !out) fail(`usage: ${USAGE.export}`);
  const { events: raw, file } = await loadEvents(resolve(src));
  // The run folder as it is now, and as it was when the run wrote paths into its log.
  const runDirs = new Set([dirname(file)]);
  for (const e of raw) if (e.type === "run_end" && e.patchPath && isAbsolute(e.patchPath)) runDirs.add(dirname(e.patchPath));
  const start = raw.find((e) => e.type === "run_start");
  const repo = start?.type === "run_start" && isAbsolute(start.repo) ? start.repo : undefined;
  const { events, changed } = scrubPaths(raw, { home: homedir(), runDirs: [...runDirs], repo });
  const dir = resolve(out);
  await mkdir(dir, { recursive: true });
  for (const f of ["index.html", "app.js", "style.css"]) await copyFile(join(PKG_ROOT, "ui", f), join(dir, f));
  await writeFile(join(dir, "data.js"), `window.FORKBOMB_EVENTS = ${JSON.stringify(events)};\n`);
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`${CLI}: exported ${events.length} events from ${basename(resolve(src))} to ${dir}`);
  if (changed) console.log(`${CLI}: replaced local paths in ${changed} field${changed === 1 ? "" : "s"} (home folder → ~, run folder → <run>, repo → ./${repo ? basename(repo) : "<repo>"})`);
}

async function cmdBench(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      forks: { type: "string", default: "16" },
      "no-copy": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) usage("bench");
  const src = resolve(positionals[0] ?? ".");
  const forks = Number(values.forks);
  if (!Number.isInteger(forks) || forks < 1 || forks > 64) fail("--forks must be between 1 and 64");
  const st = await stat(src).catch(() => null);
  if (!st) fail(`no such directory: ${src}`);
  if (!st.isDirectory()) fail(`not a directory: ${src} (bench forks a whole folder, like a repo)`);
  const rows = await bench(src, forks, !values["no-copy"]);
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else {
    const scratch = join(appHome(), "bench");
    const note = rows.some((r) => r.forker === "apfs-clonefile")
      ? ""
      : `\n\nno clonefile row: ${src} and ${tildify(scratch)} aren't on the same APFS volume, so clones aren't possible (set ${HOME_ENV} to a folder on that volume).`;
    console.log(`${benchTable(rows)}\n\nworkspace: ${src}${note}`);
  }
}

function printCanary(c: CanaryResult): void {
  if (c.error) console.log(`FAIL  Claude Code isolation canary: ${c.error}`);
  for (const k of c.checks) console.log(`${k.ok ? "ok  " : "FAIL"}  canary: ${k.name} (${k.detail})`);
}

async function cmdCanary(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { "claude-bin": { type: "string" }, model: { type: "string" }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) usage("canary");
  const c = await runCanary({ bin: values["claude-bin"], model: values.model });
  printCanary(c);
  console.log(
    c.ok
      ? `${CLI}: Claude Code ${shortVersion(c.version)} keeps forks sealed in.`
      : c.inconclusive
        ? `${CLI}: isolation check inconclusive.`
        : `${CLI}: isolation check failed.`,
  );
  process.exit(c.ok ? 0 : 1);
}

/** The hosted client from env / <home>/.env, or exit with how to get a key. */
function hostedClient(): HostedClient {
  loadEnvFile(HOSTED_KEY_ENV);
  const { baseUrl, apiKey } = hostedSettings();
  if (!apiKey) {
    fail(`no hosted API key. Create a workspace at ${BRAND.site}/app, then set ${HOSTED_KEY_ENV} or put ${HOSTED_KEY_ENV}=... in ${ENV_FILE}.`);
  }
  try {
    return new HostedClient({ baseUrl, apiKey });
  } catch (e) {
    fail((e as Error).message);
  }
}

async function cmdCredits(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } } });
  if (values.help) usage("credits");
  const client = hostedClient();
  const me = await client.me(AbortSignal.timeout(15_000)).catch((e: Error) => fail(e.message));
  console.log(values.json ? JSON.stringify(me, null, 2) : formatCredits(me, client.topUpUrl));
}

/**
 * From inside the fork sandbox: does a loopback server answer, and is a connection to an address that isn't this
 * machine refused outright? 192.0.2.1 is a documentation address, so nothing real is contacted either way.
 */
async function sandboxNetwork(root: string): Promise<{ loopback: boolean; outboundBlocked: boolean }> {
  const server = createServer((s) => s.end("loop-ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const node = JSON.stringify(process.execPath);
  const probe =
    `${node} -e 'const net = require("net");` +
    `const l = net.connect(${port}, "127.0.0.1"); l.on("data", (d) => console.log(String(d))); l.on("error", (e) => console.log("LOOP_" + e.code));` +
    `const o = net.connect({ host: "192.0.2.1", port: 443, timeout: 3000 }); o.on("connect", () => { console.log("OUT_OPEN"); o.destroy(); });` +
    `o.on("timeout", () => { console.log("OUT_TIMEOUT"); o.destroy(); }); o.on("error", (e) => console.log("OUT_" + e.code));'`;
  try {
    const r = await runSandboxed(probe, { root, tmp: join(root, ".tmp"), network: false, gitWrite: false }, { timeoutMs: 15_000, maxOutput: 2000 });
    return { loopback: r.output.includes("loop-ok"), outboundBlocked: r.output.includes("OUT_EPERM") };
  } finally {
    server.close();
  }
}

async function cmdDoctor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h", default: false } } });
  if (values.help) usage("doctor");
  loadEnvFile();
  let failed = 0;
  const check = (ok: boolean, label: string, hint = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && hint ? `  (${hint})` : ""}`);
  };
  check(process.platform === "darwin", "macOS", "the sandbox and clonefile need macOS");
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `Node ${process.versions.node}`, "needs Node 22+");
  await mkdir(appHome(), { recursive: true });
  check(await canClone(appHome(), appHome()), "APFS copy-on-write clones", `${appHome()} is not on APFS; ${BRAND.name} will fall back to plain copies`);
  const cc = await exec("/usr/bin/clang", ["--version"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  check(cc.code === 0, "clang (builds the clone helper)", "run: xcode-select --install");
  const tmp = join(appHome(), "doctor");
  await mkdir(tmp, { recursive: true });
  const r = await runSandboxed("echo ok > inside && { (echo bad > ../outside) 2>/dev/null; echo $?; }", { root: tmp, tmp: join(tmp, ".tmp"), network: false, gitWrite: false }, { timeoutMs: 10_000, maxOutput: 1000 });
  check(r.output.trim() === "1" && existsSync(join(tmp, "inside")) && !existsSync(join(appHome(), "outside")), "Seatbelt sandbox confines writes");
  const net = await sandboxNetwork(tmp);
  check(net.outboundBlocked && net.loopback, "Seatbelt sandbox blocks outbound network, keeps loopback", net.loopback ? "a sandboxed connection to an outside address wasn't refused" : "loopback didn't work inside the sandbox");
  const st = await exec("claude", ["auth", "status"]).catch(() => null);
  const claudeIn = !!st && !/"loggedIn":\s*false/.test(st.stdout);
  const apiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hs = hostedSettings();
  // Claude Code is the default engine, but not the only one: without it, a key for another engine will do.
  if (claudeIn || (!apiKey && !hs.apiKey)) {
    check(claudeIn, "Claude Code logged in (engine: claude-code, uses your Claude plan)", st ? "run: claude auth login" : "install Claude Code, or set up --engine api or hosted");
  } else console.log("info  Claude Code isn't logged in. That's fine if you use --engine api or hosted");
  if (apiKey) console.log("ok    Anthropic API key (engine: api)");
  else console.log(`info  No Anthropic API key. That's fine: it's only needed for --engine api (put ANTHROPIC_API_KEY=... in ${ENV_FILE})`);
  if (!hs.apiKey) console.log(`info  No hosted key (${HOSTED_KEY_ENV}). That's fine: it's only needed for --engine hosted`);
  else {
    try {
      const client = new HostedClient({ baseUrl: hs.baseUrl, apiKey: hs.apiKey, maxRetries: 0 });
      const me = await client.me(AbortSignal.timeout(8000));
      check(true, `hosted key (engine: hosted): credit $${me.credits.balanceUsd.toFixed(4)} (${me.workspace.label || me.workspace.id}) at ${client.label.replace(/^hosted /, "")}`);
    } catch (e) {
      // A key the gateway turns down is broken; a gateway that can't be reached right now is only worth a note.
      if (e instanceof HostedError && e.kind === "auth") check(false, "hosted key (engine: hosted)", (e as Error).message);
      else console.log(`info  hosted key set, but the gateway check failed: ${(e as Error).message}`);
    }
  }
  if (claudeIn) {
    const version = (await exec("claude", ["--version"])).stdout.trim();
    if (cachedCanaryPass(version)) console.log(`ok    Claude Code ${shortVersion(version)} isolation canary (passed earlier)`);
    else console.log(`info  Claude Code isolation canary hasn't run for this version yet: ${CLI} canary`);
  }
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  // However the CLI exits, no fork, test run or Claude Code session it started outlives it.
  process.on("exit", () => killAll("SIGKILL"));
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "bench":
      return cmdBench(rest);
    case "replay":
      return cmdReplay(rest);
    case "export":
      return cmdExport(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "credits":
      return cmdCredits(rest);
    case "canary":
      return cmdCanary(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      fail(`unknown command ${cmd}. Try ${CLI} --help`);
  }
}

main().catch((e: Error) => fail(e.message));
