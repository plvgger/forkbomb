import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ApfsForker, CopyForker, type Forker, canClone } from "./fork/forker.js";
import { fmtBytes, freeBytes, forkbombHome, treeBytes } from "./util.js";

export interface BenchRow {
  forker: string;
  heads: number;
  msTotal: number;
  msPerHead: number;
  logicalBytes: number;
  physicalBytes: number;
}

async function measure(forker: Forker, src: string, heads: number, scratch: string): Promise<BenchRow> {
  const dir = await mkdtemp(join(scratch, `${forker.name}-`));
  const dsts = Array.from({ length: heads }, (_, i) => join(dir, `h${i}`));
  const workspace = await treeBytes(src);
  const free0 = await freeBytes(scratch);
  const t0 = performance.now();
  await forker.fork(src, dsts);
  const msTotal = performance.now() - t0;
  const free1 = await freeBytes(scratch);
  await rm(dir, { recursive: true, force: true });
  return {
    forker: forker.name,
    heads,
    msTotal,
    msPerHead: msTotal / heads,
    logicalBytes: workspace * heads,
    physicalBytes: Math.max(0, free0 - free1),
  };
}

/** Fork the same workspace with clonefile and with a plain copy, and report both honestly. */
export async function bench(src: string, heads: number, withCopy: boolean): Promise<BenchRow[]> {
  const scratch = join(forkbombHome(), "bench");
  await mkdir(scratch, { recursive: true });
  const rows: BenchRow[] = [];
  if (await canClone(src, scratch)) rows.push(await measure(await ApfsForker.create(), src, heads, scratch));
  if (withCopy) rows.push(await measure(new CopyForker(), src, heads, scratch));
  return rows;
}

export function benchTable(rows: BenchRow[]): string {
  const head = ["forker", "heads", "total", "per head", "logical", "physical"];
  const body = rows.map((r) => [
    r.forker,
    String(r.heads),
    `${r.msTotal.toFixed(1)} ms`,
    `${r.msPerHead.toFixed(2)} ms`,
    fmtBytes(r.logicalBytes),
    fmtBytes(r.physicalBytes),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}
