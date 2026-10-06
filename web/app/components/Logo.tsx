import Link from "next/link";
import { SITE } from "../config";
import { cx } from "./cx";

/**
 * Pixel mark, 8×8 grid: one process at the root forks into four. Three heads in
 * currentColor (killed), one in phosphor green (exit 0). Shared with icon.svg and the OG card.
 * "#" = currentColor, "o" = survivor.
 */
export const MARK_GRID = [
  "#.#..#.o",
  "#.#..#.#",
  "###..###",
  ".#....#.",
  ".######.",
  "...##...",
  "...##...",
  "..####..",
] as const;

export const MARK_OK = "#3cf2b4";

/** Cells of MARK_GRID as {x, y, ok}. */
export function markCells() {
  const cells: { x: number; y: number; ok: boolean }[] = [];
  MARK_GRID.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c !== ".") cells.push({ x, y, ok: c === "o" });
    });
  });
  return cells;
}

/** The pixel fork-tree mark. Inherits currentColor; the survivor pixel is green. */
export function Mark({ className, size = 22, mono = false }: { className?: string; size?: number; mono?: boolean }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {markCells().map(({ x, y, ok }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={ok && !mono ? MARK_OK : "currentColor"} />
      ))}
    </svg>
  );
}

/** Lowercase pixel wordmark "forkbomb" (Tiny5). Text, so it's selectable and crisp at any size. */
export function Wordmark({ className, glow = false }: { className?: string; glow?: boolean }) {
  return <span className={cx("brand__word", glow && "crt-glow", className)}>{SITE.wordmark}</span>;
}

/** Mark + wordmark, linking home. */
export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cx("brand", className)} aria-label={`${SITE.name} home`}>
      <Mark className="brand__mark" />
      <span className="brand__word" aria-hidden="true">
        {SITE.wordmark}
      </span>
    </Link>
  );
}

/**
 * The classic Unix fork bomb, :(){ :|:& };: — the brand glyph.
 * Function name and "&" (background fork) in signal orange.
 */
export function Glyph({
  className,
  glow = false,
  pixel = false,
}: {
  className?: string;
  /** CRT glow on the orange parts. */
  glow?: boolean;
  /** Render in the pixel display face instead of mono. */
  pixel?: boolean;
}) {
  return (
    <code className={cx("glyph", glow && "glyph--glow", pixel && "glyph--pixel", className)} translate="no">
      <span className="glyph__fn">:()</span>
      {"{ "}
      <span className="glyph__fn">:</span>
      <span className="glyph__pipe">|</span>
      <span className="glyph__fn">:</span>
      <span className="glyph__amp">&amp;</span>
      {" };"}
      <span className="glyph__fn">:</span>
    </code>
  );
}
