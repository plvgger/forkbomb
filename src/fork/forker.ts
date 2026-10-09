import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { PKG_ROOT, appHome, exec } from "../util.js";

export interface ForkResult {
  dst: string;
  ms: number;
}

/** Turns one workspace into many. Swap the implementation, keep the forks. */
export interface Forker {
  readonly name: string;
  fork(src: string, dsts: string[]): Promise<ForkResult[]>;
}

/**
 * APFS copy-on-write clones via clonefile(2): one syscall per fork, every data
 * block shared with the parent until a fork writes to it.
 */
export class ApfsForker implements Forker {
  readonly name = "apfs-clonefile";
  private constructor(private readonly helper: string) {}

  static async create(): Promise<ApfsForker> {
    return new ApfsForker(await ensureHelper());
  }

  async fork(src: string, dsts: string[]): Promise<ForkResult[]> {
    if (dsts.length === 0) return [];
    const r = await exec(this.helper, [src, ...dsts]);
    const results = JSON.parse(r.stdout || "[]") as Array<{ dst: string; ms: number; ok: boolean; err: string }>;
    const bad = results.find((x) => !x.ok);
    if (bad || r.code !== 0) {
      throw new Error(`clonefile failed for ${bad?.dst ?? src}: ${bad?.err || r.stderr.trim() || `exit ${r.code}`}`);
    }
    return results.map(({ dst, ms }) => ({ dst, ms }));
  }
}

/** Plain recursive copy. The honest baseline in `forkbomb bench`, and the fallback off APFS. */
export class CopyForker implements Forker {
  readonly name = "copy";
  async fork(src: string, dsts: string[]): Promise<ForkResult[]> {
    const out: ForkResult[] = [];
    for (const dst of dsts) {
      const t0 = performance.now();
      const r = await exec("/bin/cp", ["-R", src, dst]);
      if (r.code !== 0) throw new Error(`cp failed for ${dst}: ${r.stderr.trim()}`);
      out.push({ dst, ms: performance.now() - t0 });
    }
    return out;
  }
}

/**
 * Compile the clonefile helper once per helper source and cache it under <home>/bin. The name comes from a
 * hash of the source, so every checkout of the same source shares one binary (an mtime changes with each clone).
 */
export async function ensureHelper(): Promise<string> {
  const src = join(PKG_ROOT, "native", "hclone.c");
  const binDir = join(appHome(), "bin");
  const hash = createHash("sha256").update(await readFile(src)).digest("hex").slice(0, 12);
  const bin = join(binDir, `hclone-${hash}`);
  if (existsSync(bin)) return bin;
  await mkdir(binDir, { recursive: true });
  // Built under a temp name and renamed into place, so a concurrent run never executes half a binary.
  const tmp = `${bin}.${process.pid}.tmp`;
  const r = await exec("/usr/bin/clang", ["-O2", "-o", tmp, src]);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    throw new Error(`could not compile the clone helper (is Xcode Command Line Tools installed?): ${r.stderr.trim()}`);
  }
  // macOS checks a new binary the first time it runs, which takes 100+ ms. Pay that here, not inside a timed fork.
  await exec(tmp, []).catch(() => null);
  await rename(tmp, bin);
  return bin;
}

/** statfs f_type for APFS on macOS. */
const APFS_FSTYPE = 0x1a;

/** True when `a` and `b` live on the same APFS volume, so clones are possible. */
export async function canClone(a: string, b: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.dev !== sb.dev) return false;
  return (await statfs(a)).type === APFS_FSTYPE;
}

export async function pickForker(src: string, dstParent: string): Promise<Forker> {
  if (await canClone(src, dstParent)) {
    try {
      return await ApfsForker.create();
    } catch {
      // fall through to copy
    }
  }
  return new CopyForker();
}
