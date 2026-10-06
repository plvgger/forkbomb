import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { RUN } from "../config";
import { OG_SIZE } from "./meta";

export { OG_ALT, OG_SIZE } from "./meta";

// Shared social card for every opengraph-image / twitter-image route.
// Inter (SIL OFL 1.1, see fonts/OFL.txt) ships in app/_og/fonts so the card renders
// in the site's own face at build time, with no network fetch.

type FontDef = { name: string; data: ArrayBuffer; weight: 400 | 600; style: "normal" };
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

const C = {
  bg: "#07090b",
  raised: "#0b0e11",
  surface: "#0e1216",
  border: "#1c232a",
  borderStrong: "#27303a",
  text: "#e6ebf0",
  text2: "#a3aeb9",
  text3: "#7c8793",
  accent: "#3cf2b4",
  danger: "#ff5a5f",
};

/** The brand mark: one neck forking into three heads. */
export function MarkSvg({ size, color = C.accent }: { size: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <path
        d="M16 29V17M16 17C16 11 9 11 6 5M16 17C16 11 23 11 26 5M16 17V4"
        fill="none"
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="5" r="2.4" fill={color} />
      <circle cx="16" cy="4" r="2.4" fill={color} />
      <circle cx="26" cy="5" r="2.4" fill={color} />
    </svg>
  );
}

// The real run, drawn as a tree. x positions of the four heads inside a 420px-wide panel.
const HEAD_X = [60, 160, 260, 360];
const BODY = { x: 210, y: 330 };
const FORK = { x: 210, y: 250 };
const HEAD_Y = 124;

function RunTree() {
  const winnerIndex = RUN.heads.findIndex((h) => h.id === RUN.winner.id);
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: 420,
        height: 400,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        background: C.raised,
      }}
    >
      <svg width="420" height="400" viewBox="0 0 420 400" style={{ position: "absolute", top: 0, left: 0 }}>
        <path d={`M${BODY.x} ${BODY.y}V${FORK.y}`} stroke={C.borderStrong} strokeWidth="2" fill="none" />
        {HEAD_X.map((x, i) => {
          const win = i === winnerIndex;
          return (
            <path
              key={x}
              d={`M${FORK.x} ${FORK.y}C${FORK.x} ${FORK.y - 70} ${x} ${HEAD_Y + 90} ${x} ${HEAD_Y + 14}`}
              stroke={win ? C.accent : C.danger}
              strokeOpacity={win ? 1 : 0.55}
              strokeWidth={win ? 2.5 : 1.75}
              strokeDasharray={win ? undefined : "5 6"}
              fill="none"
            />
          );
        })}
        <circle cx={BODY.x} cy={BODY.y} r="7" fill={C.text3} />
        <circle cx={FORK.x} cy={FORK.y} r="5" fill={C.text3} />
        {HEAD_X.map((x, i) => {
          const win = i === winnerIndex;
          return (
            <circle
              key={x}
              cx={x}
              cy={HEAD_Y}
              r={win ? 12 : 9}
              fill={win ? C.accent : C.surface}
              stroke={win ? C.accent : C.danger}
              strokeWidth="2"
            />
          );
        })}
      </svg>

      {/* Head labels */}
      {RUN.heads.map((h, i) => {
        const win = i === winnerIndex;
        return (
          <div
            key={h.id}
            style={{
              position: "absolute",
              top: 24,
              left: HEAD_X[i] - 50,
              width: 100,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              fontSize: 15,
              color: win ? C.text : C.text3,
            }}
          >
            <div style={{ display: "flex", fontWeight: 600 }}>{h.id}</div>
            <div style={{ display: "flex", fontSize: 13 }}>{h.strategy}</div>
            <div
              style={{
                display: "flex",
                marginTop: 6,
                fontSize: 11,
                letterSpacing: 1.2,
                color: win ? C.accent : C.danger,
                opacity: win ? 1 : 0.75,
              }}
            >
              {win ? `PASS ${RUN.winner.passed}/${RUN.winner.total}` : "SEVERED"}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          top: BODY.y + 18,
          left: 0,
          width: 420,
          display: "flex",
          justifyContent: "center",
          fontSize: 14,
          color: C.text3,
        }}
      >
        {`baseline ${RUN.baseline.passing}/${RUN.baseline.total} passing`}
      </div>
    </div>
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
  title = "Fork your agent. Let the tests pick the survivor.",
  sub = "Sandboxed heads in milliseconds. Open source. macOS.",
}: CardCopy = {}) {
  const fonts = await loadFonts();
  const stats = [
    `${RUN.heads.length} heads`,
    "1 survivor",
    `${RUN.winner.passed}/${RUN.winner.total} tests`,
    `${RUN.durationS}s`,
  ];
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: C.bg,
          backgroundImage: `linear-gradient(${C.border} 1px, transparent 1px), linear-gradient(90deg, ${C.border} 1px, transparent 1px)`,
          backgroundSize: "40px 40px",
          color: C.text,
          fontFamily: "Inter",
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            padding: 64,
            justifyContent: "space-between",
            alignItems: "center",
            backgroundImage: `radial-gradient(ellipse 80% 90% at 30% 50%, ${C.bg} 40%, rgba(7,9,11,0.82) 100%)`,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              height: "100%",
              width: 620,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <MarkSvg size={44} />
              <div style={{ display: "flex", fontSize: 28, letterSpacing: 9, fontWeight: 600 }}>FORKBOMB</div>
              {kicker && (
                <div
                  style={{
                    display: "flex",
                    marginLeft: 8,
                    padding: "6px 12px",
                    border: `1px solid ${C.borderStrong}`,
                    borderRadius: 8,
                    fontSize: 20,
                    color: C.text2,
                  }}
                >
                  {kicker}
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <div style={{ display: "flex", fontSize: 62, fontWeight: 600, lineHeight: 1.06, letterSpacing: -1.9 }}>
                {title}
              </div>
              <div style={{ display: "flex", fontSize: 24, fontWeight: 400, color: C.text2, lineHeight: 1.4 }}>
                {sub}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 22, color: C.text2 }}>
              {stats.map((s, i) => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {i > 0 && <div style={{ display: "flex", color: C.text3 }}>·</div>}
                  <div style={{ display: "flex", color: i === 2 ? C.accent : C.text }}>{s}</div>
                </div>
              ))}
            </div>
          </div>

          <RunTree />
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
