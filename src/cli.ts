#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModel, type Effort } from "./agent.js";
import { bench, benchTable } from "./bench.js";
import { BRAND, HOME_ENV, HOSTED_KEY_ENV, HOSTED_URL_ENV, legacyEnvInUse } from "./brand.js";
import { EventBus, type Stamped } from "./events.js";
import { type CanaryResult, cachedCanaryPass, runCanary } from "./engines/canary.js";
import { HostedClient, formatCredits, hostedSettings } from "./engines/hosted.js";
import { canClone } from "./fork/forker.js";
import { DEFAULT_PROTECT } from "./judge.js";
import { runRace } from "./orchestrator.js";
import { runSandboxed } from "./sandbox.js";
import { serve } from "./server.js";
import { PKG_ROOT, appHome, exec, fmtBytes, resolveHome } from "./util.js";

const CLI = BRAND.slug;
const HOME = `~/.${BRAND.slug}`;

const HELP = `${CLI}: fork a coding agent into N sandboxed copies of your repo. They race, the tests judge, the losers get killed and one exits 0.

Usage
  ${CLI} run [repo] --task "..." --test "npm test" [options]
  ${CLI} bench [dir] [--forks 16] [--no-copy]
  ${CLI} replay <run-dir | events.jsonl> [--port 4317] [--no-open]
  ${CLI} export <run-dir> <out-dir>
  ${CLI} doctor
  ${CLI} credits       show hosted credit balance and pricing (--json)
  ${CLI} canary        prove Claude Code forks can't escape (runs a tiny session)

run options
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
  --max-turns N       tool-use turns per fork (default 30)
  --fork-timeout S    seconds per fork (default 600)
  --bash-timeout S    seconds per shell command (default 120)
  --test-timeout S    seconds per test run (default 300)
  --concurrency N     max forks talking to the API at once (default 8)
  --protect GLOB      extra read-only path for forks (repeatable)
  --no-default-protect  don't protect test files and test config by default
  --apply             apply the winning patch to the repo
  --keep-forks        keep killed forks' clones on disk
  --network           let forks reach the network (default: loopback only)
  --no-sandbox        run forks without the macOS sandbox (not recommended)
  --ui                open the live process tree in your browser
  --port N            port for --ui / replay (default 4317)
  --no-open           don't open a browser for --ui
  --runs-dir DIR      where runs live (default ${HOME}/runs)
  -v, --verbose       print every tool call

Credentials: with --engine claude-code, whatever Claude Code is logged in with
(claude auth login). With --engine api, ANTHROPIC_API_KEY in the environment or
in ${HOME}/.env. With --engine hosted, ${HOSTED_KEY_ENV} in the environment or in
${HOME}/.env (get a key and top up at ${BRAND.site}/app; ${HOSTED_URL_ENV}
overrides the gateway, default ${BRAND.site}/api/v1). Keys stay on your machine:
the Anthropic key goes only to Anthropic, the hosted key only to the hosted
gateway, and no key ever reaches a fork. Self-hosting stays free.
${HOME_ENV} moves ${HOME}. The old --heads, --head-timeout and --keep-heads flags
and HYDRA_* env names still work.`;

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

function openBrowser(url: string): void {
  spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The repo copy every fork descends from is "body" in events; people see it as pid 1. */
const pid = (id: string) => (id === "body" ? "pid 1" : id);

/** Compact terminal narration of a run. Event types and fields keep their original names for replay. */
function narrate(e: Stamped, verbose: boolean): void {
  const t = `${(e.t / 1000).toFixed(1).padStart(6)}s`;
  const say = (s: string) => console.log(`${t}  ${s}`);
  switch (e.type) {
    case "run_start":
      say(`run ${e.runId}: ${e.heads} forks × ${e.rounds} rounds · ${e.model} (${e.effort}) · ${e.mode} · sandbox ${e.sandbox ? "on" : "OFF"}${e.engine === "claude-code" ? " · on your Claude subscription" : e.engine === "hosted" ? " · on hosted credit" : ""}`);
      break;
    case "baseline":
      say(`baseline: ${e.passed ?? "?"} passing, ${e.failed ?? "?"} failing (exit ${e.exitCode})`);
      break;
    case "fork": {
      const avg = e.msEach.reduce((a, b) => a + b, 0) / Math.max(1, e.msEach.length);
      say(`fork  ${e.heads.length} × ${pid(e.parent)} in ${avg.toFixed(2)} ms each via ${e.forker} · ${fmtBytes(e.logicalBytes)} logical, ${fmtBytes(e.physicalBytes ?? 0)} physical`);
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
      say(`  ${e.head} killed (${e.why})`);
      break;
    case "round_end":
      say(`round ${e.round}: best ${e.best ?? "none"} at ${Math.round(e.bestScore * 100)}%`);
      break;
    case "winner":
      say(`EXIT 0 ${e.head}: ${e.diffLines} lines in ${e.filesChanged} file(s). ${e.summary.split("\n")[0] ?? ""}`);
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
      forks: { type: "string" },
      heads: { type: "string" }, // pre-rename name of --forks
      rounds: { type: "string", default: "2" },
      mode: { type: "string", default: "race" },
      engine: { type: "string", default: "claude-code" },
      model: { type: "string" },
      "claude-bin": { type: "string" },
      effort: { type: "string", default: "medium" },
      "max-turns": { type: "string", default: "30" },
      "fork-timeout": { type: "string" },
      "head-timeout": { type: "string" }, // pre-rename name of --fork-timeout
      "bash-timeout": { type: "string", default: "120" },
      "test-timeout": { type: "string", default: "300" },
      concurrency: { type: "string", default: "8" },
      protect: { type: "string", multiple: true, default: [] },
      "no-default-protect": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "keep-forks": { type: "boolean", default: false },
      "keep-heads": { type: "boolean", default: false }, // pre-rename name of --keep-forks
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
  const heads = int("forks", values.forks ?? values.heads ?? "8", 1, 64);
  const rounds = int("rounds", values.rounds, 1, 10);
  const mode = values.mode === "best" ? "best" : values.mode === "race" ? "race" : fail("--mode must be race or best");
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  if (!efforts.includes(values.effort!)) fail(`--effort must be one of ${efforts.join(", ")}`);
  if (values["no-sandbox"]) console.warn(`${CLI}: WARNING: --no-sandbox lets forks write anywhere your user can.`);
  if (process.platform !== "darwin" && !values["no-sandbox"]) fail("the sandbox needs macOS. Use --no-sandbox at your own risk.");

  const engine =
    values.engine === "api" || values.engine === "claude-code" || values.engine === "hosted"
      ? values.engine
      : fail("--engine must be claude-code, api or hosted");
  let hosted: HostedClient | null = null;
  if (engine === "api") {
    loadEnvFile("ANTHROPIC_API_KEY");
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      fail(`no API key. Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in ${HOME}/.env. Or use --engine claude-code to run on your Claude subscription.`);
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
    if (values.network) fail("--network isn't supported with --engine claude-code yet.");
    const version = (await exec(bin, ["--version"])).stdout.trim();
    if (!cachedCanaryPass(version)) {
      console.log(`${CLI}: first run with Claude Code ${version}: checking that forks are sealed in (about a minute)…`);
      const c = await runCanary({ bin });
      printCanary(c);
      if (!c.ok) fail("isolation check failed, so no forks were started. See above.");
    }
  }

  const runsDir = resolve(values["runs-dir"] ?? join(appHome(), "runs"));
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
    console.log(`${CLI}: live view at ${server.url}`);
    if (!values["no-open"]) openBrowser(server.url);
  }


  const result = await runRace(
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
        : hosted
          ? { hosted }
          : { claudeCode: { model: values.model, bin: values["claude-bin"] } }),
      effort: values.effort!,
      maxTurns: int("max-turns", values["max-turns"], 1, 500),
      headTimeoutMs: int("fork-timeout", values["fork-timeout"] ?? values["head-timeout"] ?? "600", 10, 86_400) * 1000,
      bashTimeoutMs: int("bash-timeout", values["bash-timeout"], 1, 3600) * 1000,
      testTimeoutMs: int("test-timeout", values["test-timeout"], 1, 7200) * 1000,
      maxOutput: 12_000,
      network: values.network!,
      sandbox: !values["no-sandbox"],
      protect: [...(values["no-default-protect"] ? [] : DEFAULT_PROTECT), ...(values.protect ?? [])],
      apply: values.apply!,
      keepHeads: values["keep-forks"]! || values["keep-heads"]!,
      runsDir,
      concurrency: int("concurrency", values.concurrency, 1, 64),
    },
    bus,
  ).catch((e: Error) => {
    bus.emit({ type: "log", level: "error", msg: e.message });
    return null;
  });

  console.log(`${CLI}: run saved in ${runDir}`);
  if (server) {
    console.log(`${CLI}: view stays up at ${server.url}. Ctrl-C to quit.`);
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
  if (!positionals[0]) fail(`usage: ${CLI} replay <run-dir | events.jsonl>`);
  const events = await loadEvents(resolve(positionals[0]));
  const { url } = await serve({ replay: events }, Number(values.port));
  console.log(`${CLI}: replaying ${events.length} events at ${url}. Ctrl-C to quit.`);
  if (!values["no-open"]) openBrowser(url);
}

/** A static, self-contained replay you can host anywhere (Vercel, GitHub Pages). */
async function cmdExport(argv: string[]): Promise<void> {
  const [src, out] = argv;
  if (!src || !out) fail(`usage: ${CLI} export <run-dir> <out-dir>`);
  const events = await loadEvents(resolve(src));
  const dir = resolve(out);
  await mkdir(dir, { recursive: true });
  for (const f of ["index.html", "app.js", "style.css"]) await copyFile(join(PKG_ROOT, "ui", f), join(dir, f));
  await writeFile(join(dir, "data.js"), `window.HYDRA_EVENTS = ${JSON.stringify(events)};\n`);
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`${CLI}: exported ${events.length} events from ${basename(resolve(src))} to ${dir}`);
}

async function cmdBench(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      forks: { type: "string" },
      heads: { type: "string" }, // pre-rename name of --forks
      "no-copy": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const src = resolve(positionals[0] ?? ".");
  const heads = Number.parseInt(values.forks ?? values.heads ?? "16", 10);
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
  console.log(c.ok ? `${CLI}: Claude Code ${c.version} keeps forks sealed in.` : `${CLI}: isolation check failed.`);
  process.exit(c.ok ? 0 : 1);
}

/** The hosted client from env / <home>/.env, or exit with how to get a key. */
function hostedClient(): HostedClient {
  loadEnvFile(HOSTED_KEY_ENV);
  const { baseUrl, apiKey } = hostedSettings();
  if (!apiKey) {
    fail(`no hosted API key. Create a workspace at ${BRAND.site}/app, then set ${HOSTED_KEY_ENV} or put ${HOSTED_KEY_ENV}=... in ${HOME}/.env.`);
  }
  try {
    return new HostedClient({ baseUrl, apiKey });
  } catch (e) {
    fail((e as Error).message);
  }
}

async function cmdCredits(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } } });
  const client = hostedClient();
  const me = await client.me(AbortSignal.timeout(15_000)).catch((e: Error) => fail(e.message));
  console.log(values.json ? JSON.stringify(me, null, 2) : formatCredits(me, client.topUpUrl));
}

async function cmdDoctor(): Promise<void> {
  loadEnvFile();
  const check = (ok: boolean, label: string, hint = "") => console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && hint ? `  (${hint})` : ""}`);
  check(process.platform === "darwin", "macOS", "the sandbox and clonefile need macOS");
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 22, `Node ${process.versions.node}`, "needs Node 22+");
  const home = resolveHome();
  if (home.legacy) console.log(`info  ${home.legacy}`);
  const oldEnv = legacyEnvInUse();
  if (oldEnv.length) console.log(`info  deprecated env names still read, please rename: ${oldEnv.join(", ")}`);
  await mkdir(home.dir, { recursive: true });
  check(await canClone(appHome(), appHome()), "APFS copy-on-write clones", `${appHome()} is not on APFS; ${BRAND.name} will fall back to plain copies`);
  const cc = await exec("/usr/bin/clang", ["--version"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  check(cc.code === 0, "clang (builds the clone helper)", "run: xcode-select --install");
  const tmp = join(appHome(), "doctor");
  await mkdir(tmp, { recursive: true });
  const r = await runSandboxed("echo ok > inside && { (echo bad > ../outside) 2>/dev/null; echo $?; }", { root: tmp, tmp: join(tmp, ".tmp"), network: false, gitWrite: false }, { timeoutMs: 10_000, maxOutput: 1000 });
  check(r.output.trim() === "1" && existsSync(join(tmp, "inside")) && !existsSync(join(appHome(), "outside")), "Seatbelt sandbox confines writes");
  const st = await exec("claude", ["auth", "status"]).catch(() => null);
  const claudeIn = !!st && !/"loggedIn":\s*false/.test(st.stdout);
  check(claudeIn, "Claude Code logged in (engine: claude-code, uses your Claude plan)", st ? "run: claude auth login" : "install Claude Code");
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) console.log("ok    Anthropic API key (engine: api)");
  else console.log("info  No Anthropic API key. That's fine: it's only needed for --engine api");
  const hs = hostedSettings();
  if (!hs.apiKey) console.log(`info  No hosted key (${HOSTED_KEY_ENV}). That's fine: it's only needed for --engine hosted`);
  else {
    console.log(`ok    hosted key set (engine: hosted)`);
    try {
      const client = new HostedClient({ baseUrl: hs.baseUrl, apiKey: hs.apiKey, maxRetries: 0 });
      const me = await client.me(AbortSignal.timeout(8000));
      console.log(`ok    hosted credit $${me.credits.balanceUsd.toFixed(4)} (${me.workspace.label || me.workspace.id}) at ${client.label.replace(/^hosted /, "")}`);
    } catch (e) {
      console.log(`info  hosted gateway check failed: ${(e as Error).message}`);
    }
  }
  if (claudeIn) {
    const version = (await exec("claude", ["--version"])).stdout.trim();
    if (cachedCanaryPass(version)) console.log(`ok    Claude Code ${version} isolation canary (passed earlier)`);
    else console.log(`info  Claude Code isolation canary hasn't run for this version yet: ${CLI} canary`);
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
