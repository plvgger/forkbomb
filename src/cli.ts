#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModel, type Effort } from "./agent.js";
import { bench, benchTable } from "./bench.js";
import { EventBus, type Stamped } from "./events.js";
import { type CanaryResult, cachedCanaryPass, runCanary } from "./engines/canary.js";
import { canClone } from "./fork/forker.js";
import { DEFAULT_PROTECT } from "./judge.js";
import { runHydra } from "./orchestrator.js";
import { runSandboxed } from "./sandbox.js";
import { serve } from "./server.js";
import { PKG_ROOT, exec, fmtBytes, hydraHome } from "./util.js";

const HELP = `hydra: fork a coding agent into N sandboxed heads. They race, the tests judge, one survives.

Usage
  hydra run [repo] --task "..." --test "npm test" [options]
  hydra bench [dir] [--heads 16] [--no-copy]
  hydra replay <run-dir | events.jsonl> [--port 4317] [--no-open]
  hydra export <run-dir> <out-dir>
  hydra doctor
  hydra canary        prove Claude Code heads can't escape (runs a tiny session)

run options
  --heads N           heads per round (default 8)
  --rounds N          rounds; each round forks from the best head so far (default 2)
  --mode race|best    race: first full pass wins and the rest are cut (default)
                      best: let every head finish, keep the smallest passing diff
  --engine NAME       claude-code: run heads through Claude Code on your
                      Claude subscription (default)
                      api: call the Anthropic API with an API key
  --model ID          model for the heads (api default: claude-opus-5-5;
                      claude-code default: your Claude Code default)
  --effort LEVEL      low | medium | high | xhigh | max (default medium)
  --max-turns N       tool-use turns per head (default 30)
  --head-timeout S    seconds per head (default 600)
  --bash-timeout S    seconds per shell command (default 120)
  --test-timeout S    seconds per test run (default 300)
  --concurrency N     max heads talking to the API at once (default 8)
  --protect GLOB      extra read-only path for heads (repeatable)
  --no-default-protect  don't protect test files and test config by default
  --apply             apply the winning patch to the repo
  --keep-heads        keep losing heads' clones on disk
  --network           let heads reach the network (default: loopback only)
  --no-sandbox        run heads without the macOS sandbox (not recommended)
  --ui                open the live tree view in your browser
  --port N            port for --ui / replay (default 4317)
  --no-open           don't open a browser for --ui
  --runs-dir DIR      where runs live (default ~/.hydra/runs)
  -v, --verbose       print every tool call

Credentials: with --engine claude-code, whatever Claude Code is logged in with
(claude auth login). With --engine api, ANTHROPIC_API_KEY in the environment or
in ~/.hydra/.env. Keys stay on your machine; Hydra never sends them anywhere
but Anthropic.`;

function loadEnvFile(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const f = join(hydraHome(), ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function fail(msg: string): never {
  console.error(`hydra: ${msg}`);
  process.exit(1);
}

function openBrowser(url: string): void {
  spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Compact terminal narration of a run. */
function narrate(e: Stamped, verbose: boolean): void {
  const t = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
  const say = (s: string) => console.log(`${t}  ${s}`);
  switch (e.type) {
    case "run_start":
      say(`run ${e.runId}: ${e.heads} heads × ${e.rounds} rounds · ${e.model} (${e.effort}) · ${e.mode} · sandbox ${e.sandbox ? "on" : "OFF"}${e.engine === "claude-code" ? " · on your Claude subscription" : ""}`);
      break;
    case "baseline":
      say(`baseline: ${e.passed ?? "?"} passing, ${e.failed ?? "?"} failing (exit ${e.exitCode})`);
      break;
    case "fork": {
      const avg = e.msEach.reduce((a, b) => a + b, 0) / Math.max(1, e.msEach.length);
      say(`fork  ${e.heads.length} heads from ${e.parent} in ${avg.toFixed(2)} ms each via ${e.forker} · ${fmtBytes(e.logicalBytes)} logical, ${fmtBytes(e.physicalBytes ?? 0)} physical`);
      break;
    }
    case "head_start":
      if (verbose) say(`  ${e.head} ${e.strategy}`);
      break;
    case "tool":
      if (verbose) say(`  ${e.head} ${e.tool === "bash" ? "$" : "✎"} ${e.summary}`);
      break;
    case "head_done":
      if (e.reason !== "severed") say(`  ${e.head} done: ${e.reason} after ${e.turns} turns${e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ""}${e.error ? ` · ${e.error}` : ""}`);
      break;
    case "judge": {
      const total = e.passed != null && e.failed != null ? e.passed + e.failed : null;
      const mark = e.score === 1 ? "PASS" : "fail";
      say(`  ${e.head} ${mark} ${total != null ? `${e.passed}/${total}` : `${Math.round(e.score * 100)}%`} · ${e.diffLines} lines${e.tampered.length ? ` · reverted test edits: ${e.tampered.join(", ")}` : ""}`);
      break;
    }
    case "sever":
      say(`  ${e.head} severed (${e.why})`);
      break;
    case "round_end":
      say(`round ${e.round}: best ${e.best ?? "none"} at ${Math.round(e.bestScore * 100)}%`);
      break;
    case "winner":
      say(`SURVIVOR ${e.head}: ${e.diffLines} lines in ${e.filesChanged} file(s). ${e.summary.split("\n")[0] ?? ""}`);
      break;
    case "run_end":
      say(`done in ${(e.ms / 1000).toFixed(1)}s${e.costUsd != null ? ` · $${e.costUsd.toFixed(2)}` : ""}${e.patchPath ? ` · patch: ${e.patchPath}` : ""}${e.applied ? " · applied" : ""}`);
      break;
    case "log":
      say(`${e.level === "info" ? "" : `${e.level}: `}${e.msg}`);
      break;
  }
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      test: { type: "string" },
      heads: { type: "string", default: "8" },
      rounds: { type: "string", default: "2" },
      mode: { type: "string", default: "race" },
      engine: { type: "string", default: "claude-code" },
      model: { type: "string" },
      "claude-bin": { type: "string" },
      effort: { type: "string", default: "medium" },
      "max-turns": { type: "string", default: "30" },
      "head-timeout": { type: "string", default: "600" },
      "bash-timeout": { type: "string", default: "120" },
      "test-timeout": { type: "string", default: "300" },
      concurrency: { type: "string", default: "8" },
      protect: { type: "string", multiple: true, default: [] },
      "no-default-protect": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "keep-heads": { type: "boolean", default: false },
      network: { type: "boolean", default: false },
      "no-sandbox": { type: "boolean", default: false },
      ui: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      port: { type: "string", default: "4317" },
      "runs-dir": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
    },
  });
  const repo = resolve(positionals[0] ?? ".");
  if (!values.task) fail("--task is required");
  if (!values.test) fail("--test is required (the command that decides who wins)");
  if (!(await stat(repo).catch(() => null))?.isDirectory()) fail(`not a directory: ${repo}`);
  const int = (k: string, v: string | undefined, min: number, max: number) => {
    const n = Number.parseInt(v ?? "", 10);
    if (!Number.isFinite(n) || n < min || n > max) fail(`--${k} must be between ${min} and ${max}`);
    return n;
  };
  const heads = int("heads", values.heads, 1, 64);
  const rounds = int("rounds", values.rounds, 1, 10);
  const mode = values.mode === "best" ? "best" : values.mode === "race" ? "race" : fail("--mode must be race or best");
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  if (!efforts.includes(values.effort!)) fail(`--effort must be one of ${efforts.join(", ")}`);
  if (values["no-sandbox"]) console.warn("hydra: WARNING: --no-sandbox lets heads write anywhere your user can.");
  if (process.platform !== "darwin" && !values["no-sandbox"]) fail("the sandbox needs macOS. Use --no-sandbox at your own risk.");

  const engine = values.engine === "api" ? "api" : values.engine === "claude-code" ? "claude-code" : fail("--engine must be claude-code or api");
  if (engine === "api") {
    loadEnvFile();
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      fail("no API key. Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in ~/.hydra/.env. Or use --engine claude-code to run on your Claude subscription.");
    }
  } else {
    const bin = values["claude-bin"] ?? "claude";
    const st = await exec(bin, ["auth", "status"]).catch(() => null);
    if (!st) fail("Claude Code isn't installed (no `claude` on PATH). Install it, or use --engine api.");
    if (/"loggedIn":\s*false/.test(st.stdout)) fail("Claude Code isn't logged in. Run `claude auth login` with your Claude subscription, then try again.");
    if (values.network) fail("--network isn't supported with --engine claude-code yet.");
    const version = (await exec(bin, ["--version"])).stdout.trim();
    if (!cachedCanaryPass(version)) {
      console.log(`hydra: first run with Claude Code ${version}: checking that heads are sealed in (about a minute)…`);
      const c = await runCanary({ bin });
      printCanary(c);
      if (!c.ok) fail("isolation check failed, so no heads were started. See above.");
    }
  }

  const runsDir = resolve(values["runs-dir"] ?? join(hydraHome(), "runs"));
  await mkdir(runsDir, { recursive: true });
  if (runsDir.startsWith(`${repo}/`)) fail("--runs-dir can't be inside the repo");
  const id = runId();
  const runDir = join(runsDir, id);
  await mkdir(runDir, { recursive: true });
  const bus = new EventBus(join(runDir, "events.jsonl"));
  bus.on((e) => narrate(e, values.verbose!));

  let server: Awaited<ReturnType<typeof serve>> | null = null;
  if (values.ui) {
    server = await serve({ live: bus }, Number(values.port));
    console.log(`hydra: live view at ${server.url}`);
    if (!values["no-open"]) openBrowser(server.url);
  }


  const result = await runHydra(
    {
      runId: id,
      repo,
      task: values.task,
      testCmd: values.test,
      heads,
      rounds,
      mode,
      ...(engine === "api"
        ? { model: new AnthropicModel(new Anthropic({ maxRetries: 4 }), values.model ?? "claude-opus-5-5", values.effort as Effort) }
        : { claudeCode: { model: values.model, bin: values["claude-bin"] } }),
      effort: values.effort!,
      maxTurns: int("max-turns", values["max-turns"], 1, 500),
      headTimeoutMs: int("head-timeout", values["head-timeout"], 10, 86_400) * 1000,
      bashTimeoutMs: int("bash-timeout", values["bash-timeout"], 1, 3600) * 1000,
      testTimeoutMs: int("test-timeout", values["test-timeout"], 1, 7200) * 1000,
      maxOutput: 12_000,
      network: values.network!,
      sandbox: !values["no-sandbox"],
      protect: [...(values["no-default-protect"] ? [] : DEFAULT_PROTECT), ...(values.protect ?? [])],
      apply: values.apply!,
      keepHeads: values["keep-heads"]!,
      runsDir,
      concurrency: int("concurrency", values.concurrency, 1, 64),
    },
    bus,
  ).catch((e: Error) => {
    bus.emit({ type: "log", level: "error", msg: e.message });
    return null;
  });

  console.log(`hydra: run saved in ${runDir}`);
  if (server) {
    console.log(`hydra: view stays up at ${server.url}. Ctrl-C to quit.`);
  } else process.exit(result?.ok ? 0 : 1);
}

async function loadEvents(target: string): Promise<Stamped[]> {
  const file = (await stat(target)).isDirectory() ? join(target, "events.jsonl") : target;
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Stamped);
}

async function cmdReplay(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: "4317" }, "no-open": { type: "boolean", default: false } },
  });
  if (!positionals[0]) fail("usage: hydra replay <run-dir | events.jsonl>");
  const events = await loadEvents(resolve(positionals[0]));
  const { url } = await serve({ replay: events }, Number(values.port));
  console.log(`hydra: replaying ${events.length} events at ${url}. Ctrl-C to quit.`);
  if (!values["no-open"]) openBrowser(url);
}

/** A static, self-contained replay you can host anywhere (Vercel, GitHub Pages). */
async function cmdExport(argv: string[]): Promise<void> {
  const [src, out] = argv;
  if (!src || !out) fail("usage: hydra export <run-dir> <out-dir>");
  const events = await loadEvents(resolve(src));
  const dir = resolve(out);
  await mkdir(dir, { recursive: true });
  for (const f of ["index.html", "app.js", "style.css"]) await copyFile(join(PKG_ROOT, "ui", f), join(dir, f));
  await writeFile(join(dir, "data.js"), `window.HYDRA_EVENTS = ${JSON.stringify(events)};\n`);
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`hydra: exported ${events.length} events from ${basename(resolve(src))} to ${dir}`);
}

async function cmdBench(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { heads: { type: "string", default: "16" }, "no-copy": { type: "boolean", default: false }, json: { type: "boolean", default: false } },
  });
  const src = resolve(positionals[0] ?? ".");
  const heads = Number.parseInt(values.heads!, 10);
  const rows = await bench(src, heads, !values["no-copy"]);
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else console.log(`${benchTable(rows)}\n\nworkspace: ${src}`);
}

function printCanary(c: CanaryResult): void {
  if (c.error) console.log(`FAIL  Claude Code isolation canary: ${c.error}`);
  for (const k of c.checks) console.log(`${k.ok ? "ok  " : "FAIL"}  canary: ${k.name} (${k.detail})`);
}

async function cmdCanary(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { "claude-bin": { type: "string" }, model: { type: "string" } } });
  const c = await runCanary({ bin: values["claude-bin"], model: values.model });
  printCanary(c);
  console.log(c.ok ? `hydra: Claude Code ${c.version} keeps heads sealed in.` : "hydra: isolation check failed.");
  process.exit(c.ok ? 0 : 1);
}

async function cmdDoctor(): Promise<void> {
  loadEnvFile();
  const check = (ok: boolean, label: string, hint = "") => console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && hint ? `  (${hint})` : ""}`);
  check(process.platform === "darwin", "macOS", "the sandbox and clonefile need macOS");
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `Node ${process.versions.node}`, "needs Node 22+");
  await mkdir(hydraHome(), { recursive: true });
  check(await canClone(hydraHome(), hydraHome()), "APFS copy-on-write clones", "~/.hydra is not on APFS; Hydra will fall back to plain copies");
  const cc = await exec("/usr/bin/clang", ["--version"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  check(cc.code === 0, "clang (builds the clone helper)", "run: xcode-select --install");
  const tmp = join(hydraHome(), "doctor");
  await mkdir(tmp, { recursive: true });
  const r = await runSandboxed("echo ok > inside && { (echo bad > ../outside) 2>/dev/null; echo $?; }", { root: tmp, tmp: join(tmp, ".tmp"), network: false, gitWrite: false }, { timeoutMs: 10_000, maxOutput: 1000 });
  check(r.output.trim() === "1" && existsSync(join(tmp, "inside")) && !existsSync(join(hydraHome(), "outside")), "Seatbelt sandbox confines writes");
  const st = await exec("claude", ["auth", "status"]).catch(() => null);
  const claudeIn = !!st && !/"loggedIn":\s*false/.test(st.stdout);
  check(claudeIn, "Claude Code logged in (engine: claude-code, uses your Claude plan)", st ? "run: claude auth login" : "install Claude Code");
  check(!!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), "Anthropic API key (engine: api, optional)", "only needed for --engine api");
  if (claudeIn) {
    const version = (await exec("claude", ["--version"])).stdout.trim();
    if (cachedCanaryPass(version)) console.log(`ok    Claude Code ${version} isolation canary (passed earlier)`);
    else console.log("info  Claude Code isolation canary hasn't run for this version yet: hydra canary");
  }
}

async function main(): Promise<void> {
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
      return cmdDoctor();
    case "canary":
      return cmdCanary(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      fail(`unknown command ${cmd}. Try hydra --help`);
  }
}

main().catch((e: Error) => fail(e.message));
