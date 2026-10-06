import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, HOME_ENV, LEGACY_ENV, LEGACY_SLUG } from "./brand.js";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface HomeDir {
  dir: string;
  /** Set when the dir came from a pre-rename name: what to move or rename. */
  legacy: string | null;
}

/**
 * Where runs, the clone helper, the canary record and the .env file live:
 * <SLUG>_HOME, then the pre-rename env name, then ~/.<slug>. An existing
 * ~/.<legacy> is used only while ~/.<slug> doesn't exist yet.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): HomeDir {
  const set = env[HOME_ENV]?.trim();
  if (set) return { dir: set, legacy: null };
  const oldEnv = LEGACY_ENV[HOME_ENV]!;
  const old = env[oldEnv]?.trim();
  if (old) return { dir: old, legacy: `${oldEnv} is deprecated; rename it to ${HOME_ENV}` };
  const dir = join(home, `.${BRAND.slug}`);
  const legacyDir = join(home, `.${LEGACY_SLUG}`);
  if (!existsSync(dir) && existsSync(legacyDir)) {
    return { dir: legacyDir, legacy: `using legacy ~/.${LEGACY_SLUG}; move it to ~/.${BRAND.slug}` };
  }
  return { dir, legacy: null };
}

export function appHome(): string {
  return resolveHome().dir;
}

/** Single-quote a string for /bin/sh. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a trusted local command (never model output) and capture its output. */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Allocated size of a tree in bytes, as `du` reports it. */
export async function treeBytes(dir: string): Promise<number> {
  const r = await exec("/usr/bin/du", ["-sk", dir]);
  const kb = Number.parseInt(r.stdout.split(/\s/)[0] ?? "0", 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** Bytes still available on the volume holding `path`. */
export async function freeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}

export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${n < 0 ? "-" : ""}${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Keep the head and tail of long output, which is where errors live. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${dropped} chars omitted]…\n${text.slice(-tail)}`;
}

/** Minimal glob matcher: `**` crosses directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: RegExp[]): boolean {
  return globs.some((g) => g.test(path));
}

/** Small counting semaphore so N heads don't all hit the API at once. */
export class Semaphore {
  private queue: Array<() => void> = [];
  constructor(private slots: number) {}
  async acquire(): Promise<() => void> {
    if (this.slots > 0) {
      this.slots--;
      return () => this.release();
    }
    await new Promise<void>((r) => this.queue.push(r));
    return () => this.release();
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.slots++;
  }
}
