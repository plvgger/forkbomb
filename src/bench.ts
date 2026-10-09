import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ApfsForker, CopyForker, type Forker, canClone } from "./fork/forker.js";
import { appHome, fmtBytes, freeBytes, treeBytes } from "./util.js";

export interface BenchRow {
  forker: string;
  forks: number;
  msTotal: number;
  msPerFork: number;
  logicalBytes: number;
  physicalBytes: number;
}

async function measure(forker: Forker, src: string, forks: number, scratch: string): Promise<BenchRow> {
  const dir = await mkdtemp(join(scratch, `${forker.name}-`));
  // One untimed fork first, so neither forker is timed paying a one-off cost (a first exec, a cold file cache).
  await forker.fork(src, [join(dir, "warmup")]);
  await rm(join(dir, "warmup"), { recursive: true, force: true });
  const dsts = Array.from({ length: forks }, (_, i) => join(dir, `f${i}`));
  const workspace = await treeBytes(src);
  const free0 = await freeBytes(scratch);
  const t0 = performance.now();
  await forker.fork(src, dsts);
  const msTotal = performance.now() - t0;
  const free1 = await freeBytes(scratch);
  await rm(dir, { recursive: true, force: true });
  return {
    forker: forker.name,
    forks,
    msTotal,
    msPerFork: msTotal / forks,
    logicalBytes: workspace * forks,
    physicalBytes: Math.max(0, free0 - free1),
  };
}

/** Fork the same workspace with clonefile and with a plain copy, and report both honestly. */
export async function bench(src: string, forks: number, withCopy: boolean): Promise<BenchRow[]> {
  const scratch = join(appHome(), "bench");
  await mkdir(scratch, { recursive: true });
  const rows: BenchRow[] = [];
  if (await canClone(src, scratch)) rows.push(await measure(await ApfsForker.create(), src, forks, scratch));
  if (withCopy) rows.push(await measure(new CopyForker(), src, forks, scratch));
  return rows;
}

export function benchTable(rows: BenchRow[]): string {
  const head = ["forker", "forks", "total", "per fork", "logical", "physical"];
  const body = rows.map((r) => [
    r.forker,
    String(r.forks),
    `${r.msTotal.toFixed(1)} ms`,
    `${r.msPerFork.toFixed(2)} ms`,
    fmtBytes(r.logicalBytes),
    fmtBytes(r.physicalBytes),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}
