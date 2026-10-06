// Geometry for the fork bomb illustration (hero canvas, its SVG poster, the OG card).
// Plain module, no "use client", so server routes can import it.
// One process (pid 1) at the center forks 2 -> 4 -> 8 -> 16 -> 32 -> 64 in rings.
// Coordinates are normalized: center (0, 0), outer ring radius ~1.

export const DEPTH = 6;
export const RADII = [0, 0.19, 0.35, 0.5, 0.65, 0.81, 0.965];
export const NODE_PX = [6.5, 5, 4.4, 3.8, 3.2, 2.7, 2.3]; // half-size of a node square at scale 1, by depth
export const TAU = Math.PI * 2;

export type ForkNode = { idx: number; d: number; i: number; a: number; x: number; y: number; parent: number; pid: number };

export function buildTree(): ForkNode[] {
  const out: ForkNode[] = [];
  for (let d = 0; d <= DEPTH; d++) {
    const n = 1 << d;
    for (let i = 0; i < n; i++) {
      const idx = n - 1 + i;
      const a = d === 0 ? -Math.PI / 2 : ((i + 0.5) / n) * TAU - Math.PI / 2;
      const r = RADII[d];
      out.push({
        idx,
        d,
        i,
        a,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        parent: d === 0 ? -1 : (1 << (d - 1)) - 1 + (i >> 1),
        pid: d === 0 ? 1 : 4096 + idx, // illustrative pids
      });
    }
  }
  return out;
}

export const NODES = buildTree();
export const TOTAL = NODES.length; // 127
export const OUTER0 = (1 << DEPTH) - 1; // first index of the outer ring (63)
export const FORKS = TOTAL - 1; // 126 fork() calls
export const KILLED = TOTAL - (DEPTH + 1); // everything off the survivor's lineage: 120
/**
 * Only the final survivor exits 0. The DEPTH - 1 forks between pid 1 and it are its parents:
 * neither killed nor exits. FORKS = KILLED + (DEPTH - 1) parents + EXITED.
 */
export const EXITED = 1;

/** Quadratic control point for the edge into node n. */
export function ctrl(n: ForkNode): [number, number] {
  const p = NODES[n.parent];
  if (n.d === 1) return [(p.x + n.x) / 2, (p.y + n.y) / 2];
  const r = (RADII[p.d] + RADII[n.d]) / 2 + 0.03;
  return [Math.cos(p.a) * r, Math.sin(p.a) * r];
}
export const CTRL = NODES.map((n) => (n.parent < 0 ? ([0, 0] as [number, number]) : ctrl(n)));

export function lineageOf(leaf: number): Set<number> {
  const set = new Set<number>();
  for (let k = leaf; k >= 0; k = NODES[k].parent) set.add(k);
  return set;
}

