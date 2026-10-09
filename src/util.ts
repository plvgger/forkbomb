import { spawn } from "node:child_process";
import { mkdir, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, HOME_ENV } from "./brand.js";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where runs, the clone helper, the canary record and the .env file live: <SLUG>_HOME, else ~/.<slug>. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[HOME_ENV]?.trim() || join(home, `.${BRAND.slug}`);
}

export function appHome(): string {
  return resolveHome();
}

/** A path as people type it: the home folder as ~. */
export function tildify(p: string, home = homedir()): string {
  return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

/** A run's id: its local start time to the second, e.g. 20261009-135746. */
export function runId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Create a new run's folder and return its id. Two runs started in the same second get -2, -3, ...:
 * mkdir without `recursive` fails if the folder exists, so two runs can never share one.
 */
export async function makeRunDir(runsDir: string, d = new Date()): Promise<string> {
  const base = runId(d);
  for (let i = 1; i < 1000; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    try {
      await mkdir(join(runsDir, id));
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`too many runs started at ${base}`);
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

/** Small counting semaphore so N forks don't all hit the API at once. */
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
