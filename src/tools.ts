import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { type SandboxSpec, runSandboxed } from "./sandbox.js";
import { clip } from "./util.js";

/** Anthropic-defined, schema-less tools. Each head gets exactly these two. */
export const HEAD_TOOLS = [
  { type: "bash_20250124" as const, name: "bash" as const },
  { type: "text_editor_20250728" as const, name: "str_replace_based_edit_tool" as const },
];

/** Every head sees the same virtual root, so all heads share one cached prompt prefix. */
export const VIRTUAL_ROOT = "/workspace";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".forkbomb-runs", ".forkbomb-runs"]);
const MAX_VIEW_CHARS = 24_000;

export interface ToolOutcome {
  text: string;
  isError: boolean;
  summary: string;
}

export class ToolError extends Error {}

/** One head's workspace: a clone directory plus the sandbox rules that confine it. */
export class Workspace {
  readonly rootReal: string;

  constructor(
    readonly spec: SandboxSpec,
    private readonly limits: { bashTimeoutMs: number; maxOutput: number },
  ) {
    this.rootReal = realpathSync(spec.root);
  }

  /**
   * Map a model-supplied path into this workspace, or throw. Paths are untrusted:
   * each existing component is lstat'd so a symlink planted by a head's shell
   * can't carry a write outside the clone or into .git.
   */
  resolve(p: string): string {
    if (typeof p !== "string" || p.length === 0) throw new ToolError("path is required");
    if (p.includes("\0")) throw new ToolError("invalid path");
    let rel: string;
    if (p === VIRTUAL_ROOT || p.startsWith(`${VIRTUAL_ROOT}/`)) rel = p.slice(VIRTUAL_ROOT.length + 1);
    else if (isAbsolute(p)) {
      const r = relative(this.rootReal, normalize(p));
      if (r.startsWith("..") || isAbsolute(r)) throw new ToolError(`path is outside the workspace: ${p}`);
      rel = r;
    } else rel = p;

    const target = normalize(join(this.rootReal, rel));
    this.assertInside(target, p);

    const parts = relative(this.rootReal, target).split(sep).filter(Boolean);
    let cur = this.rootReal;
    for (let k = 0; k < parts.length; k++) {
      const next = join(cur, parts[k]!);
      let st;
      try {
        st = lstatSync(next);
      } catch {
        cur = join(cur, ...parts.slice(k));
        break;
      }
      if (st.isSymbolicLink()) {
        try {
          cur = realpathSync(next);
        } catch {
          throw new ToolError(`path goes through a broken symlink: ${p}`);
        }
      } else cur = next;
      this.assertInside(cur, p);
    }
    this.assertInside(cur, p);
    return cur;
  }

  private assertInside(abs: string, original: string): void {
    const r = relative(this.rootReal, abs);
    if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new ToolError(`path escapes the workspace: ${original}`);
    const lower = r.toLowerCase();
    if (lower === ".git" || lower.startsWith(`.git${sep}`)) throw new ToolError(".git is read-only for forks");
  }

  display(abs: string): string {
    const r = relative(this.rootReal, abs);
    return r ? `${VIRTUAL_ROOT}/${r}` : VIRTUAL_ROOT;
  }

  async bash(input: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
    const i = (input ?? {}) as { command?: unknown; restart?: unknown };
    if (i.restart === true) return { text: "Shell restarted.", isError: false, summary: "restart" };
    if (typeof i.command !== "string" || !i.command.trim()) {
      return { text: "bash needs a non-empty `command` string.", isError: true, summary: "bad input" };
    }
    const r = await runSandboxed(i.command, this.spec, {
      timeoutMs: this.limits.bashTimeoutMs,
      maxOutput: this.limits.maxOutput,
      signal,
    });
    const status = r.timedOut
      ? `[timed out after ${Math.round(this.limits.bashTimeoutMs / 1000)}s]`
      : r.aborted
        ? "[aborted]"
        : `[exit code ${r.code}]`;
    const body = r.output.trim() ? r.output.trimEnd() : "(no output)";
    return { text: `${body}\n${status}`, isError: r.code !== 0, summary: i.command.split("\n")[0]!.slice(0, 120) };
  }

  async edit(input: unknown): Promise<ToolOutcome> {
    const i = (input ?? {}) as Record<string, unknown>;
    const cmd = i.command;
    try {
      if (typeof i.path !== "string") throw new ToolError("`path` must be a string");
      const abs = this.resolve(i.path);
      const shown = this.display(abs);
      switch (cmd) {
        case "view":
          return { text: await this.view(abs, i.view_range), isError: false, summary: `view ${shown}` };
        case "create": {
          if (typeof i.file_text !== "string") throw new ToolError("create needs `file_text`");
          await mkdir(dirname(abs), { recursive: true });
          await safeWrite(abs, i.file_text, shown);
          return { text: `Created ${shown}.`, isError: false, summary: `create ${shown}` };
        }
        case "str_replace": {
          if (typeof i.old_str !== "string") throw new ToolError("str_replace needs `old_str`");
          const newStr = typeof i.new_str === "string" ? i.new_str : "";
          const text = await readText(abs, shown);
          const count = text.split(i.old_str).length - 1;
          if (count === 0) throw new ToolError(`No match for old_str in ${shown}. Re-view the file; whitespace must match exactly.`);
          if (count > 1) throw new ToolError(`old_str matches ${count} times in ${shown}; include more surrounding context to make it unique.`);
          await safeWrite(abs, text.replace(i.old_str, () => newStr), shown);
          return { text: `Edited ${shown}.`, isError: false, summary: `edit ${shown}` };
        }
        case "insert": {
          const line = i.insert_line;
          const ins = typeof i.insert_text === "string" ? i.insert_text : typeof i.new_str === "string" ? i.new_str : null;
          if (typeof line !== "number" || !Number.isInteger(line) || line < 0) throw new ToolError("insert needs an integer `insert_line` >= 0");
          if (ins === null) throw new ToolError("insert needs `insert_text`");
          const lines = (await readText(abs, shown)).split("\n");
          if (line > lines.length) throw new ToolError(`insert_line ${line} is past the end (${lines.length} lines)`);
          lines.splice(line, 0, ...ins.split("\n"));
          await safeWrite(abs, lines.join("\n"), shown);
          return { text: `Inserted after line ${line} of ${shown}.`, isError: false, summary: `insert ${shown}:${line}` };
        }
        default:
          throw new ToolError(`unknown command ${String(cmd)}; use view, create, str_replace or insert`);
      }
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `error: ${(e as Error).message}`;
      return { text: msg, isError: true, summary: `${String(cmd)} failed` };
    }
  }

  private async view(abs: string, range: unknown): Promise<string> {
    const s = await stat(abs).catch(() => null);
    if (!s) throw new ToolError(`${this.display(abs)} does not exist`);
    if (s.isDirectory()) return this.listDir(abs);
    const lines = (await readText(abs, this.display(abs))).split("\n");
    let start = 1;
    let end = lines.length;
    if (Array.isArray(range) && range.length === 2) {
      const [a, b] = range as [number, number];
      if (Number.isInteger(a) && a >= 1) start = a;
      if (Number.isInteger(b) && b !== -1) end = Math.min(b, lines.length);
    }
    const body = lines
      .slice(start - 1, end)
      .map((l, k) => `${String(start + k).padStart(6)}\t${l}`)
      .join("\n");
    return clip(body, MAX_VIEW_CHARS);
  }

  private async listDir(abs: string): Promise<string> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (out.length > 400) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        out.push(`${this.display(p)}${e.isDirectory() ? "/" : ""}`);
        if (e.isDirectory() && depth < 2) await walk(p, depth + 1);
      }
    };
    await walk(abs, 1);
    return out.length ? out.join("\n") : "(empty directory)";
  }
}

/**
 * Write without following a final-component symlink, and refuse hard links:
 * a head's shell could hard-link a file from outside the clone into it.
 */
async function safeWrite(abs: string, text: string, shown: string): Promise<void> {
  const st = await lstat(abs).catch(() => null);
  if (st && !st.isFile()) throw new ToolError(`${shown} is not a regular file`);
  if (st && st.nlink > 1) throw new ToolError(`${shown} is hard-linked; refusing to write through it`);
  const fh = await open(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

async function readText(abs: string, shown: string): Promise<string> {
  const s = await stat(abs).catch(() => null);
  if (!s) throw new ToolError(`${shown} does not exist`);
  if (s.isDirectory()) throw new ToolError(`${shown} is a directory`);
  if (!s.isFile()) throw new ToolError(`${shown} is not a regular file`);
  if (s.size > 2_000_000) throw new ToolError(`${shown} is too large to edit (${s.size} bytes)`);
  return readFile(abs, "utf8");
}
