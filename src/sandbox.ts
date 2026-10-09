import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { killGroup, track, untrack } from "./procs.js";
import { clip } from "./util.js";

export interface SandboxSpec {
  /** Workspace the commands may write to. */
  root: string;
  /** Private temp dir for this fork. */
  tmp: string;
  /** Allow outbound network (default: loopback only). */
  network: boolean;
  /** Allow writes to root/.git. Forks never get this; the judge does. */
  gitWrite: boolean;
  /** Turn the Seatbelt sandbox off (not recommended; for non-macOS dev only). */
  disabled?: boolean;
  /** Extra folders under ~ a fork may read (e.g. a shared fixtures dir). */
  allowRead?: string[];
  /**
   * Folders outside ~ that are as private as ~: nothing in them is readable except the clone and the temp
   * dir. The orchestrator passes the runs folder, so sibling forks, pid 1 and other runs stay unreadable
   * when FORKBOMB_HOME or --runs-dir puts runs outside ~.
   */
  denyRead?: string[];
}

export interface RunOutcome {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  ms: number;
}

/**
 * Toolchain folders under ~ that test commands commonly need to read. Everything
 * else under ~ (other projects, shell history, app data, credentials) is
 * unreadable from inside a fork. Add more per run with --allow-read.
 */
export const HOME_TOOLCHAINS = [
  ".nvm", ".volta", ".bun", ".deno", ".cargo", ".rustup", ".pyenv", ".rbenv", ".rvm", ".gem",
  ".asdf", ".sdkman", ".gradle", ".m2", ".npm-global", ".dotnet", ".swiftpm", "go",
  ".local/bin", ".local/lib", "Library/Python",
];

function sbString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Every folder from `home` down to (not including) `p`, when `p` is inside `home`. */
function ancestorsWithin(p: string, home: string): string[] {
  const rel = relative(home, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const out = [home];
  let cur = home;
  for (const part of rel.split(sep).slice(0, -1)) {
    cur = join(cur, part);
    out.push(cur);
  }
  return out;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Seatbelt (sandbox-exec) profile for one fork:
 * - writes only inside the fork's clone and private temp dir (.git excluded for forks);
 * - nothing under the home folder or a denyRead folder is readable except the clone, the
 *   temp dir and toolchain folders (metadata stays visible so path lookups behave normally);
 * - no network except loopback, and no access to the system DNS resolver.
 */
export function seatbeltProfile(spec: SandboxSpec): string {
  mkdirSync(spec.tmp, { recursive: true });
  const root = realpathSync(spec.root);
  const tmp = realpathSync(spec.tmp);
  const home = realpathSync(homedir());
  const readable = [root, tmp, ...HOME_TOOLCHAINS.map((p) => join(home, p)), ...(spec.allowRead ?? []).map(realOrSelf)];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbString(root)}) (subpath ${sbString(tmp)})`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ];
  if (!spec.gitWrite) lines.push(`(deny file-write* (subpath ${sbString(join(root, ".git"))}))`);
  const denied = [...new Set([home, ...(spec.denyRead ?? []).map(realOrSelf)])];
  lines.push(`(deny file-read-data file-read-xattr ${denied.map((p) => `(subpath ${sbString(p)})`).join(" ")})`);
  // Same operations as the deny above: Seatbelt ranks specific operations over file-read*.
  lines.push(`(allow file-read-data file-read-xattr ${readable.map((p) => `(subpath ${sbString(p)})`).join(" ")})`);
  // getcwd() and path walks need to list each parent folder itself (not its other children).
  const parents = [...new Set([root, tmp].flatMap((p) => denied.flatMap((d) => ancestorsWithin(p, d))))];
  if (parents.length) lines.push(`(allow file-read-data ${parents.map((p) => `(literal ${sbString(p)})`).join(" ")})`);
  if (!spec.network) {
    lines.push("(deny network*)");
    // Split by operation. One `(allow network* (local ip "localhost:*") ...)` would match every outbound
    // socket, since a socket that hasn't bound yet counts as local localhost, and so let any destination through.
    lines.push('(allow network-bind network-inbound (local ip "localhost:*"))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    lines.push('(deny mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.dnssd.service"))');
  }
  return lines.join("\n");
}

/** Largest file a sandboxed command may write, in KiB (bash `ulimit -f`): a runaway write stops at 1 GiB, not at a full disk. */
export const MAX_FILE_KIB = 1024 * 1024;
/** Processes a sandboxed command may add to the user's count (`ulimit -u` is per user on macOS), so a fork bomb stops there. */
export const PROCESS_HEADROOM = 1024;

let procCap: { at: number; cap: number | null } | null = null;

/**
 * The per-user process limit to give sandboxed commands: the user's current process count plus
 * PROCESS_HEADROOM. Recounted at most every 30 s; null when the count can't be read.
 */
export function processCap(now = Date.now()): number | null {
  if (procCap && now - procCap.at < 30_000) return procCap.cap;
  let cap: number | null = null;
  try {
    const out = execFileSync("/bin/ps", ["-U", String(process.getuid?.() ?? ""), "-o", "pid="], { encoding: "utf8", timeout: 5000 });
    cap = out.split("\n").filter((l) => l.trim()).length + PROCESS_HEADROOM;
  } catch {
    cap = null;
  }
  procCap = { at: now, cap };
  return cap;
}

/** Shell lines that set the file-size and process limits; a limit the system refuses is skipped quietly. */
export function limitsPrelude(): string {
  const cap = processCap();
  return `ulimit -f ${MAX_FILE_KIB} 2>/dev/null; ${cap ? `ulimit -u ${cap} 2>/dev/null; ` : ""}`;
}

/** The only environment a fork's shell inherits. No API keys, no tokens. */
export function cleanEnv(tmp: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.TMPDIR = tmp.endsWith("/") ? tmp : `${tmp}/`;
  env.TERM = "dumb";
  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.XDG_CONFIG_HOME = join(tmp, "config");
  // A repo's .npmrc can't swap the shell npm uses to run scripts.
  env.npm_config_script_shell = "/bin/sh";
  env.npm_config_node_options = "";
  // Tool caches would otherwise write to ~/ (denied) or read ~/.npmrc (denied).
  env.NPM_CONFIG_USERCONFIG = join(tmp, "npmrc");
  env.NPM_CONFIG_CACHE = join(tmp, "npm-cache");
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env.PIP_CACHE_DIR = join(tmp, "pip-cache");
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.XDG_CACHE_HOME = join(tmp, "cache");
  return env;
}

/**
 * Run a shell command inside the sandbox, with a hard timeout, an output cap, and file-size and
 * process-count limits. The command itself runs in a fresh `bash -c`, exactly as given.
 */
export function runSandboxed(
  command: string,
  spec: SandboxSpec,
  opts: { timeoutMs: number; maxOutput: number; signal?: AbortSignal },
): Promise<RunOutcome> {
  const t0 = performance.now();
  const env = cleanEnv(spec.tmp);
  const shell = ["/bin/bash", "-c", `${limitsPrelude()}exec /bin/bash -c "$0"`, command];
  const [bin, args] = spec.disabled ? [shell[0]!, shell.slice(1)] : ["/usr/bin/sandbox-exec", ["-p", seatbeltProfile(spec), ...shell]];

  return new Promise((done) => {
    if (opts.signal?.aborted) {
      done({ code: null, output: "", timedOut: false, aborted: true, ms: 0 });
      return;
    }
    const child = spawn(bin, args as string[], { cwd: spec.root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    track(child.pid);
    let out = "";
    let overflow = 0;
    const cap = opts.maxOutput * 4;
    const take = (d: Buffer) => {
      if (out.length < cap) out += d.toString();
      else overflow += d.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.signal?.removeEventListener("abort", onAbort);
      untrack(child.pid);
      // A process that escaped the group can hold the pipes open forever; stop listening.
      child.stdout.destroy();
      child.stderr.destroy();
      let output = out;
      if (overflow) output += `\n…[${overflow} more bytes dropped]`;
      done({ code, output: clip(output, opts.maxOutput), timedOut, aborted, ms: performance.now() - t0 });
    };
    // After a kill or a normal exit, wait briefly for the pipes to drain, then give up on them.
    const settleSoon = (code: number | null) => {
      if (!grace) grace = setTimeout(() => finish(code), 1500);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      settleSoon(null);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup(child.pid);
      settleSoon(null);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // When the shell exits, take down anything it left running in its group.
    child.on("exit", (code) => {
      killGroup(child.pid);
      settleSoon(code);
    });
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      out += String(err);
      finish(null);
    });
  });
}
