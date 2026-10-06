import { RUN } from "../config";
import s from "./home.module.css";

/*
 * The Hydra loop, drawn from the real run: one body, four heads, one judge gate,
 * three severed, one survivor. Two layouts: wide (>= 1024px) and tall (tablets, phones).
 * Static by default. When the wrapping <Reveal> adds .is-in, lines draw in (JS only).
 */

const HEADS = RUN.heads;
const WIN = RUN.winner.id;

/* ---------- Wide ---------- */
const W_HEAD_Y = [120, 195, 270, 345];
const W_TICKS: number[][] = [
  [474, 514, 550, 586],
  [468, 502, 562],
  [480, 522, 542, 578],
  [466, 500, 534, 574, 612, 650, 692],
];

function Wide() {
  return (
    <svg
      className={`${s.diagram} ${s.diagramWide}`}
      viewBox="0 0 1120 410"
      role="img"
      aria-labelledby="loop-wide-title loop-wide-desc"
    >
      <title id="loop-wide-title">The Hydra loop</title>
      <desc id="loop-wide-desc">
        One body is forked into four heads: {HEADS.map((h) => `${h.id} ${h.strategy}`).join(", ")}. They race. Head{" "}
        {WIN} passes the judge first and survives with all {RUN.winner.total} tests passing. The other{" "}
        {RUN.severed} heads are severed. If no head passes, the best one seeds the next round.
      </desc>

      {/* 05 grow loop: gate back to body */}
      <path className={`${s.dLoop} ${s.dFade}`} d="M760 92 V56 Q760 40 744 40 H141 Q125 40 125 56 V194" />
      <path className={`${s.dLoopHead} ${s.dFade}`} d="M119 186 L125 196 L131 186" />
      <text className={`${s.dLabel} ${s.dFade}`} x="160" y="30">
        <tspan className={s.dIdx}>05</tspan> GROW
        <tspan className={s.dDim}> · no pass: the best head seeds the next round</tspan>
      </text>

      {/* Body */}
      <rect className={s.dBody} x="40" y="200" width="170" height="64" rx="8" />
      <text className={s.dNodeTitle} x="58" y="227">body</text>
      <text className={s.dNodeSub} x="58" y="247">base snapshot</text>

      <text className={s.dLabel} x="40" y="298">
        <tspan className={s.dIdx}>01</tspan> FORK
      </text>
      <text className={s.dNodeSub} x="40" y="318">clonefile · {RUN.forkMsEach} ms/head</text>

      {/* Fork curves */}
      {W_HEAD_Y.map((y, i) => (
        <path
          key={`f${i}`}
          className={`${s.dLine} ${s.dDraw}`}
          style={{ ["--d" as string]: `${i * 60}ms` }}
          pathLength={1}
          d={`M210 232 C252 232, 248 ${y}, 290 ${y}`}
        />
      ))}

      <text className={s.dLabel} x="456" y="86">
        <tspan className={s.dIdx}>02</tspan> RACE
      </text>
      <text className={s.dLabel} x="604" y="86">
        <tspan className={s.dIdx}>04</tspan> SEVER
      </text>

      {/* Heads, lanes, ticks */}
      {HEADS.map((h, i) => {
        const y = W_HEAD_Y[i];
        const won = h.id === WIN;
        return (
          <g key={h.id}>
            <rect
              className={won ? s.dHeadWin : s.dHeadCut}
              x="290"
              y={y - 21}
              width="162"
              height="42"
              rx="6"
            />
            <text className={s.dHeadId} x="303" y={y + 5}>
              {h.id}
            </text>
            <text className={s.dHeadName} x="348" y={y + 5}>
              {h.strategy}
            </text>
            <path
              className={`${won ? s.dLine : s.dLineMuted} ${s.dDraw}`}
              style={{ ["--d" as string]: `${300 + i * 60}ms` }}
              pathLength={1}
              d={won ? `M452 ${y} H708` : `M452 ${y} H600`}
            />
            {W_TICKS[i].map((x) => (
              <circle key={x} className={`${s.dTick} ${s.dFade}`} cx={x} cy={y} r="2.5" />
            ))}
            {!won && (
              <g className={`${s.dCut} ${s.dFadeLate}`}>
                <path d={`M606 ${y + 9} L614 ${y - 9} M614 ${y + 9} L622 ${y - 9}`} />
                <text className={s.dCutLabel} x="630" y={y + 5}>
                  severed
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Judge gate */}
      <rect className={s.dGate} x="708" y="92" width="104" height="280" rx="8" />
      <text className={s.dGateLabel} x="760" y="116" textAnchor="middle">
        <tspan className={s.dIdx}>03</tspan> JUDGE
      </text>
      <text className={s.dGateText} transform="translate(764 232) rotate(-90)" textAnchor="middle">
        fresh clone · {RUN.testCmd}
      </text>

      {/* Survivor */}
      <path
        className={`${s.dLineWin} ${s.dDraw}`}
        style={{ ["--d" as string]: "900ms" }}
        pathLength={1}
        d="M812 345 H870"
      />
      <g className={s.dFadeLate}>
        <text className={s.dWinLabel} x="870" y="311">SURVIVOR</text>
        <rect className={s.dWin} x="870" y="321" width="230" height="48" rx="8" />
        <text className={s.dWinId} x="886" y="350">
          {WIN} {RUN.winner.strategy}
        </text>
        <text className={s.dWinScore} x="1086" y="350" textAnchor="end">
          {RUN.winner.passed}/{RUN.winner.total}
        </text>
        <text className={s.dNodeSub} x="870" y="394">
          patch · {RUN.patch.lines} lines · {RUN.patch.files} file
        </text>
      </g>
    </svg>
  );
}

/* ---------- Tall (phones) ---------- */
const T_HEAD_X = [60, 140, 220, 300];
const T_TICKS: number[][] = [
  [180, 214, 262],
  [176, 206, 270],
  [184, 226, 248, 284],
  [178, 206, 238, 272, 312, 346],
];

function Tall() {
  return (
    <svg
      className={`${s.diagram} ${s.diagramTall}`}
      viewBox="0 0 360 540"
      role="img"
      aria-labelledby="loop-tall-title loop-tall-desc"
    >
      <title id="loop-tall-title">The Hydra loop</title>
      <desc id="loop-tall-desc">
        One body is forked into four heads. They race. Head {WIN} passes the judge and survives with{" "}
        {RUN.winner.passed} of {RUN.winner.total} tests passing. Three heads are severed.
      </desc>

      {/* grow loop */}
      <path className={`${s.dLoop} ${s.dFade}`} d="M30 395 H22 Q14 395 14 387 V52 Q14 44 22 44 H104" />
      <path className={`${s.dLoopHead} ${s.dFade}`} d="M98 38 L108 44 L98 50" />
      <text className={`${s.dLabelSm} ${s.dFade}`} x="22" y="32">
        <tspan className={s.dIdx}>05</tspan> GROW
      </text>

      {/* body */}
      <rect className={s.dBody} x="110" y="20" width="140" height="48" rx="8" />
      <text className={s.dNodeTitle} x="180" y="41" textAnchor="middle">body</text>
      <text className={s.dNodeSubSm} x="180" y="58" textAnchor="middle">base snapshot</text>
      <text className={s.dLabelSm} x="262" y="38">
        <tspan className={s.dIdx}>01</tspan> FORK
      </text>
      <text className={s.dNodeSubSm} x="262" y="54">{RUN.forkMsEach} ms/head</text>

      {T_HEAD_X.map((x, i) => (
        <path
          key={`f${i}`}
          className={`${s.dLine} ${s.dDraw}`}
          style={{ ["--d" as string]: `${i * 60}ms` }}
          pathLength={1}
          d={`M180 68 C180 96, ${x} 92, ${x} 120`}
        />
      ))}

      <text className={s.dLabelSm} x="180" y="276" textAnchor="middle">
        <tspan className={s.dIdx}>02</tspan> RACE
      </text>
      <text className={s.dLabelSm} x="100" y="300" textAnchor="middle">
        <tspan className={s.dIdx}>04</tspan> SEVER
      </text>

      {HEADS.map((h, i) => {
        const x = T_HEAD_X[i];
        const won = h.id === WIN;
        return (
          <g key={h.id}>
            <rect className={won ? s.dHeadWin : s.dHeadCut} x={x - 34} y="120" width="68" height="34" rx="6" />
            <text className={s.dHeadIdSm} x={x} y="142" textAnchor="middle">
              {h.id}
            </text>
            {/* Strategy name runs up the head's lane, so it stays full size on a phone. */}
            <text
              className={`${s.dHeadNameSm} ${s.dFade}`}
              transform={`translate(${x + 10} 166) rotate(90)`}
            >
              {h.strategy}
            </text>
            <path
              className={`${won ? s.dLine : s.dLineMuted} ${s.dDraw}`}
              style={{ ["--d" as string]: `${300 + i * 60}ms` }}
              pathLength={1}
              d={won ? `M${x} 154 V370` : `M${x} 154 V300`}
            />
            {T_TICKS[i].map((y) => (
              <circle key={y} className={`${s.dTick} ${s.dFade}`} cx={x} cy={y} r="2.5" />
            ))}
            {!won && (
              <g className={`${s.dCut} ${s.dFadeLate}`}>
                <path d={`M${x - 9} 314 L${x + 9} 306 M${x - 9} 322 L${x + 9} 314`} />
                <text className={s.dCutLabelSm} x={x} y="342" textAnchor="middle">
                  severed
                </text>
              </g>
            )}
          </g>
        );
      })}

      <rect className={s.dGate} x="30" y="370" width="300" height="50" rx="8" />
      <text className={s.dGateLabelSm} x="44" y="400">
        <tspan className={s.dIdx}>03</tspan> JUDGE
      </text>
      <text className={s.dGateTextSm} x="316" y="400" textAnchor="end">
        fresh clone · {RUN.testCmd}
      </text>

      <path
        className={`${s.dLineWin} ${s.dDraw}`}
        style={{ ["--d" as string]: "900ms" }}
        pathLength={1}
        d="M300 420 V452"
      />
      <g className={s.dFadeLate}>
        <rect className={s.dWin} x="166" y="452" width="178" height="54" rx="8" />
        <text className={s.dWinLabelSm} x="180" y="473">SURVIVOR</text>
        <text className={s.dWinIdSm} x="180" y="495">
          {WIN} {RUN.winner.strategy}
        </text>
        <text className={s.dWinScoreSm} x="332" y="495" textAnchor="end">
          {RUN.winner.passed}/{RUN.winner.total}
        </text>
        <text className={s.dNodeSubSm} x="344" y="526" textAnchor="end">
          patch · {RUN.patch.lines} lines · {RUN.patch.files} file
        </text>
      </g>
    </svg>
  );
}

export function LoopDiagram() {
  return (
    <>
      <Wide />
      <Tall />
    </>
  );
}
