import { spawn } from "node:child_process";
import { type Dirent, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killGroup, track, untrack } from "../procs.js";
import { createInterface } from "node:readline";
import type { ForkResult } from "../agent.js";
import type { EventBus } from "../events.js";
import { appHome } from "../util.js";

/**
 * Fork engine that drives the Claude Code CLI in headless mode (`claude -p`).
 * It runs on whatever Claude Code is logged in with, so a Claude Pro or Max
 * subscription works without API credits. Claude Code's own sandbox and
 * permission rules seal each fork inside its clone; see claudeSettings().
 */
export interface ClaudeCodeForkConfig {
  id: string;
  dir: string;
  tmp: string;
  system: string;
  prompt: string;
  model?: string;
  effort: string;
  network: boolean;
  signal: AbortSignal;
  abortReason: () => "killed" | "timeout";
  bus: EventBus;
  claudeBin?: string;
  /** Append every raw stream-json line here (used by the canary). */
  rawLog?: string;
}

/**
 * Places under ~ no fork may read or edit: credentials, app data, shell
 * history, Claude Code's own config. Claude Code's file tools can't be put
 * behind an allowlist the way our own Seatbelt sandbox does it, so this list is
 * deliberately broad.
 */
const SECRET_HOME = [
  ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
  ".config", ".gitconfig", ".claude", ".claude.json", ".cache",
  ".zsh_history", ".bash_history", ".zsh_sessions", ".python_history", ".node_repl_history", ".psql_history", ".mysql_history", ".lesshst", ".viminfo",
  "Library/Keychains", "Library/Application Support", "Library/Containers", "Library/Group Containers",
  "Library/Mail", "Library/Messages", "Library/Cookies", "Library/Safari",
  "Desktop", "Documents", "Downloads",
];

const isKeyFile = (name: string) => name === ".env" || name.endsWith(".env");

/**
 * Key files no fork may read: every `.env` and `*.env` file directly in ~, in
 * any dot-folder in ~ (where CLIs keep their keys), and in the CLI home, which
 * <SLUG>_HOME can move out of ~. The CLI's own .env is listed even before it
 * exists. Found by path when a fork starts, so one list serves both the Bash
 * sandbox and the file-tool permission rules.
 */
export function keyFiles(home = homedir(), cliHome = appHome()): string[] {
  const found = new Set([join(cliHome, ".env")]);
  const list = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return []; // missing, or unreadable to us as well
    }
  };
  const scan = (dir: string, entries = list(dir)) => {
    for (const d of entries) if (isKeyFile(d.name)) found.add(join(dir, d.name));
  };
  const top = list(home);
  scan(home, top);
  for (const d of top) if (d.name.startsWith(".") && d.isDirectory()) scan(join(home, d.name));
  scan(cliHome);
  return [...found].sort();
}

/**
 * Settings handed to each fork via --settings. Only keys from the published
 * Claude Code settings schema: in -p mode a settings block that fails
 * validation is silently ignored, so an unknown key could quietly turn the
 * sandbox off. The canary (canary.ts) proves these hold before any real run.
 *
 * - Bash runs in Claude Code's sandbox: writes only in the clone (+ its temp
 *   dir), never .git, no network, credential folders unreadable, and no
 *   escape hatch to run unsandboxed.
 * - Read/Edit/Write aren't covered by that sandbox, so permission rules deny
 *   them on credential folders and .git; acceptEdits only auto-approves edits
 *   inside the working directory, and nothing can prompt in -p mode.
 */
export function claudeSettings(o: { dir: string; tmp: string; network: boolean; keys?: string[]; extraDeny?: string[] }): object {
  const abs = (p: string) => `/${p}`; // "//abs/path" means an absolute path in Claude Code settings
  const deny = [...SECRET_HOME.map((p) => `~/${p}`), ...(o.keys ?? keyFiles()).map(abs), ...(o.extraDeny ?? []).map(abs)];
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [abs(o.tmp)],
        denyWrite: [abs(`${o.dir}/.git`)],
        denyRead: deny,
      },
      network: { allowedDomains: [], allowLocalBinding: true },
    },
    permissions: {
      deny: [
        ...deny.flatMap((p) => [`Read(${p})`, `Read(${p}/**)`, `Edit(${p})`, `Edit(${p}/**)`]),
        `Edit(${abs(`${o.dir}/.git`)}/**)`,
        "WebFetch",
        "WebSearch",
      ],
    },
  };
}

/**
 * Env for the child: an allowlist, so no API keys or tokens reach it and
 * Claude Code falls back to the subscription login.
 */
export function claudeEnv(tmp: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.TMPDIR = tmp.endsWith("/") ? tmp : `${tmp}/`;
  env.NO_COLOR = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.npm_config_script_shell = "/bin/sh";
  return env;
}

interface StreamBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: StreamBlock[] | string };
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function describe(name: string, input: Record<string, unknown> = {}): { tool: "bash" | "edit"; summary: string } {
  const path = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  switch (name) {
    case "Bash":
      return { tool: "bash", summary: String(input.command ?? "").split("\n")[0]!.slice(0, 120) };
    case "Edit":
    case "MultiEdit":
      return { tool: "edit", summary: `edit ${path}` };
    case "Write":
      return { tool: "edit", summary: `create ${path}` };
    case "Read":
      return { tool: "edit", summary: `view ${path}` };
    case "Glob":
      return { tool: "bash", summary: `glob ${String(input.pattern ?? "")}` };
    case "Grep":
      return { tool: "bash", summary: `grep ${String(input.pattern ?? "")}` };
    default:
      return { tool: "bash", summary: name };
  }
}

/** Display path relative to the clone, matching the API engine's /workspace view. */
function tidy(summary: string, dir: string): string {
  return summary.split(`${dir}/`).join("/workspace/").split(dir).join("/workspace");
}

export async function runClaudeCodeFork(cfg: ClaudeCodeForkConfig, settings: object): Promise<ForkResult> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--no-session-persistence",
    // Load no user/project/local settings: a repo's own .claude/settings.json
    // must not be able to loosen the rules below.
    "--setting-sources",
    "",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Bash,Read,Edit,Write,Glob,Grep",
    "--settings",
    JSON.stringify(settings),
    "--append-system-prompt",
    cfg.system,
    "--effort",
    cfg.effort,
  ];
  if (cfg.model) args.push("--model", cfg.model);

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let summary = "";
  let finalEvent: StreamEvent | null = null;
  let stderr = "";
  const pending = new Map<string, { tool: "bash" | "edit"; summary: string; t0: number }>();

  if (cfg.signal.aborted) return { reason: cfg.abortReason(), turns, inputTokens, outputTokens, costUsd: null, summary };

  mkdirSync(cfg.tmp, { recursive: true });
  const child = spawn(cfg.claudeBin ?? "claude", args, { cwd: cfg.dir, env: claudeEnv(cfg.tmp), stdio: ["pipe", "pipe", "pipe"], detached: true });
  track(child.pid);
  child.stdin.end(cfg.prompt);
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 8000) stderr += d.toString();
  });
  const kill = () => {
    killGroup(child.pid, "SIGTERM");
    setTimeout(() => killGroup(child.pid), 2000).unref();
  };
  cfg.signal.addEventListener("abort", kill, { once: true });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (cfg.rawLog) appendFileSync(cfg.rawLog, `${line}\n`);
    let e: StreamEvent;
    try {
      e = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    const blocks = Array.isArray(e.message?.content) ? e.message!.content : [];
    if (e.type === "assistant") {
      turns++;
      for (const b of blocks) {
        if (b.type === "tool_use" && b.id && b.name) {
          const d = describe(b.name, b.input);
          pending.set(b.id, { ...d, summary: tidy(d.summary, cfg.dir), t0: performance.now() });
        } else if (b.type === "text" && b.text?.trim()) {
          summary = b.text.trim();
          cfg.bus.emit({ type: "note", fork: cfg.id, text: tidy(summary, cfg.dir).slice(0, 280) });
        } else if (b.type === "thinking" && b.thinking?.trim()) {
          cfg.bus.emit({ type: "note", fork: cfg.id, text: b.thinking.trim().slice(0, 280) });
        }
      }
    } else if (e.type === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        cfg.bus.emit({ type: "tool", fork: cfg.id, tool: p.tool, summary: p.summary, ok: !b.is_error, ms: Math.round(performance.now() - p.t0) });
      }
    } else if (e.type === "result") {
      finalEvent = e;
      if (typeof e.result === "string" && e.result.trim()) summary = e.result.trim();
      inputTokens = (e.usage?.input_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0);
      outputTokens = e.usage?.output_tokens ?? 0;
    }
  });

  const code = await new Promise<number | null>((done) => {
    let grace: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (c: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      done(c);
    };
    // Don't let a straggler that kept the pipes open hold the fork forever.
    child.on("exit", (c) => {
      killGroup(child.pid);
      grace = setTimeout(() => finish(c), 1500);
    });
    child.on("close", (c) => finish(c));
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
  });
  untrack(child.pid);
  cfg.signal.removeEventListener("abort", kill);

  // Subscription runs aren't billed per token, so there's no honest dollar figure.
  const base = { turns, inputTokens, outputTokens, costUsd: null, summary };
  if (cfg.signal.aborted) return { reason: cfg.abortReason(), ...base };
  const fin = finalEvent as StreamEvent | null;
  if (!fin) {
    const hint = /login|log in|authenticat|credential/i.test(stderr) ? " Run `claude auth login` with your Claude subscription." : "";
    return { reason: "error", ...base, error: `claude exited ${code} with no result.${hint} ${stderr.trim().slice(0, 400)}`.trim() };
  }
  if (fin.subtype === "error_max_turns") return { reason: "max_turns", ...base };
  if (fin.is_error) {
    const msg = (fin.result ?? fin.subtype ?? "error").slice(0, 400);
    const hint = /authenticat|log ?in|oauth/i.test(msg) ? " Run `claude auth login` with your Claude subscription." : "";
    return { reason: "error", ...base, error: `${msg}${hint}` };
  }
  return { reason: "end_turn", ...base };
}
