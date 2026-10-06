import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { CTRL, lineageOf, NODES, NODE_PX, OUTER0 } from "../components/forkTree";
import { BENCH, RUN, SITE } from "../config";
import { OG_SIZE } from "./meta";

export { OG_ALT, OG_SIZE } from "./meta";

// Shared social card for every opengraph-image / twitter-image route.
// Inter (SIL OFL 1.1, see fonts/OFL.txt) ships in app/_og/fonts so the card renders
// at build time with no network fetch. The pixel wordmark is drawn from a bitmap below,
// so it needs no font file at all.

type FontDef = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: "normal";
};
let fontCache: Promise<FontDef[]> | null = null;
function loadFonts(): Promise<FontDef[]> {
  fontCache ??= (async () => {
    const dir = join(process.cwd(), "app/_og/fonts");
    const read = async (f: string) => {
      const b = await readFile(join(dir, f));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const [regular, semibold] = await Promise.all([read("Inter-Regular.ttf"), read("Inter-SemiBold.ttf")]);
    return [
      { name: "Inter", data: regular, weight: 400, style: "normal" },
      { name: "Inter", data: semibold, weight: 600, style: "normal" },
    ];
  })();
  return fontCache;
}

export const C = {
  bg: "#0a0a0b",
  raised: "#0e0e10",
  surface: "#131315",
  border: "#232327",
  borderStrong: "#2f2f34",
  text: "#ece4d4",
  text2: "#b0a999",
  text3: "#8a847a",
  signal: "#ff4d1f",
  ok: "#3cf2b4",
  dead: "#34302c",
};

/* ---------- pixel bitmap: 5×7 lowercase glyphs for the wordmark ---------- */
const GLYPHS: Record<string, string[]> = {
  f: ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
  k: ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
};

/** "forkbomb" as crisp pixel rects. `cell` = size of one pixel. */
export function PixelWordmark({
  text = "forkbomb",
  cell,
  color = C.text,
}: {
  text?: string;
  cell: number;
  color?: string;
}) {
  const chars = [...text].filter((ch) => GLYPHS[ch]);
  // Proportional advance: each glyph is as wide as its inked columns, plus one column of space.
  // (A fixed 6-column advance left a visible gap after the narrow "f".)
  const inked = (ch: string) => Math.max(...GLYPHS[ch].map((row) => row.lastIndexOf("#"))) + 1;
  const rects: { x: number; y: number }[] = [];
  let pen = 0;
  chars.forEach((ch, ci) => {
    GLYPHS[ch].forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c === "#") rects.push({ x: pen + x, y });
      });
    });
    pen += inked(ch) + (ci < chars.length - 1 ? 1 : 0);
  });
  const cols = pen;
  return (
    <svg width={cols * cell} height={7 * cell} viewBox={`0 0 ${cols} 7`} shapeRendering="crispEdges">
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}

/* ---------- pixel mark (same grid as components/Logo.tsx) ---------- */
const MARK = ["#.#..#.o", "#.#..#.#", "###..###", ".#....#.", ".######.", "...##...", "...##...", "..####.."];

export function MarkSvg({ size, color = C.signal }: { size: number; color?: string }) {
  const rects: { x: number; y: number; ok: boolean }[] = [];
  MARK.forEach((row, y) => [...row].forEach((c, x) => c !== "." && rects.push({ x, y, ok: c === "o" })));
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges">
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width="1" height="1" fill={r.ok ? C.ok : color} />
      ))}
    </svg>
  );
}

/* ---------- the burst: end frame of the hero illustration ---------- */
const SURVIVOR = OUTER0 + 26;
const LINEAGE = lineageOf(SURVIVOR);

function Burst({ size }: { size: number }) {
  const R = size / 2 - 16;
  const p = (v: number) => (size / 2 + v * R).toFixed(1);
  const sv = NODES[SURVIVOR];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {NODES.slice(1).map((n) => {
        const par = NODES[n.parent];
        const c = CTRL[n.idx];
        const live = LINEAGE.has(n.idx);
        return (
          <path
            key={`e${n.idx}`}
            d={`M${p(par.x)} ${p(par.y)}Q${p(c[0])} ${p(c[1])} ${p(n.x)} ${p(n.y)}`}
            fill="none"
            stroke={live ? C.ok : n.d >= 5 ? C.signal : C.text}
            strokeOpacity={live ? 1 : n.d >= 5 ? 0.35 : 0.14}
            strokeWidth={live ? 3 : 1.3}
          />
        );
      })}
      <circle cx={p(sv.x)} cy={p(sv.y)} r="22" fill={C.ok} fillOpacity="0.18" />
      {NODES.map((n) => {
        const live = LINEAGE.has(n.idx);
        const h = NODE_PX[n.d] * (live ? 1.5 : 1.1) * (size / 560);
        const fill = n.d === 0 ? C.text : live ? C.ok : n.d === 6 ? C.signal : C.dead;
        return (
          <rect
            key={`n${n.idx}`}
            x={(size / 2 + n.x * R - h).toFixed(1)}
            y={(size / 2 + n.y * R - h).toFixed(1)}
            width={(h * 2).toFixed(1)}
            height={(h * 2).toFixed(1)}
            fill={fill}
            fillOpacity={!live && n.d === 6 ? 0.55 : 1}
          />
        );
      })}
    </svg>
  );
}

export type CardCopy = {
  /** Small label after the wordmark, e.g. "Security". */
  kicker?: string;
  title?: string;
  sub?: string;
};

export async function renderSocialCard({
  kicker,
  title = "Fork your coding agent. Keep the patch that passes.",
  sub,
}: CardCopy = {}) {
  const fonts = await loadFonts();
  const stats: { t: string; c: string }[] = [
    { t: `${RUN.heads.length} forks`, c: C.text },
    { t: `${RUN.severed} killed`, c: C.signal },
    { t: `${RUN.winner.passed}/${RUN.winner.total} tests`, c: C.ok },
    { t: `${RUN.durationS}s`, c: C.text },
  ];
  const subline =
    sub ??
    `${BENCH.clonefile.perHeadMs} ms per fork vs ${BENCH.copy.perHeadMs.toLocaleString("en-US")} ms to copy. Open source, MIT, macOS.`;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: C.bg,
        color: C.text,
        fontFamily: "Inter",
      }}
    >
      {/* glow behind the burst */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundImage: `radial-gradient(circle at 80% 50%, rgba(255,77,31,0.16) 0%, rgba(10,10,11,0) 42%)`,
        }}
      />
      <div style={{ position: "absolute", right: 24, top: 39, display: "flex" }}>
        <Burst size={552} />
      </div>
      {/* scanlines */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundImage: "linear-gradient(rgba(0,0,0,0) 50%, rgba(0,0,0,0.22) 50%)",
          backgroundSize: "100% 4px",
        }}
      />
      {/* hazard edge */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: "100%",
          height: 10,
          display: "flex",
          backgroundImage: `repeating-linear-gradient(-45deg, ${C.signal} 0px, ${C.signal} 12px, #141414 12px, #141414 24px)`,
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: 640,
          height: "100%",
          padding: "60px 0 66px 64px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <MarkSvg size={44} />
          <PixelWordmark cell={7} />
          {kicker && (
            <div
              style={{
                display: "flex",
                marginLeft: 6,
                padding: "6px 14px",
                border: `1px solid ${C.borderStrong}`,
                borderRadius: 999,
                fontSize: 20,
                color: C.text2,
              }}
            >
              {kicker}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                display: "flex",
                alignSelf: "flex-start",
                padding: "8px 18px",
                border: `1px solid rgba(255,77,31,0.45)`,
                borderRadius: 999,
                background: "rgba(255,77,31,0.08)",
                fontSize: 26,
                fontWeight: 600,
                color: C.signal,
                letterSpacing: 1,
              }}
            >
              {SITE.glyph}
            </div>
            <div
              style={{
                display: "flex",
                padding: "9px 16px",
                border: `1px solid ${C.borderStrong}`,
                borderRadius: 999,
                background: C.surface,
                fontSize: 19,
                fontWeight: 600,
                color: C.text,
              }}
            >
              {`${SITE.ticker} · burn for compute`}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 52,
              fontWeight: 600,
              lineHeight: 1.06,
              letterSpacing: -1.6,
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              color: C.text2,
              lineHeight: 1.4,
            }}
          >
            {subline}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 22,
          }}
        >
          {stats.map((s, i) => (
            <div key={s.t} style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {i > 0 && <div style={{ display: "flex", color: C.text3 }}>·</div>}
              <div style={{ display: "flex", color: s.c }}>{s.t}</div>
            </div>
          ))}
          <div
            style={{
              display: "flex",
              color: C.text3,
              fontSize: 17,
              marginLeft: 4,
            }}
          >{`run ${RUN.date}`}</div>
        </div>
      </div>
    </div>,
    { ...OG_SIZE, fonts },
  );
}
