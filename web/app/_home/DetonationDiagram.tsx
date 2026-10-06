import { RUN } from "../config";
import s from "./home.module.css";

/*
 * One detonation, drawn from the real run: pid 1 forks four children, they race, the judge
 * gate runs the tests on a fresh clone, three get SIGKILL, one exits 0.
 * Two layouts: wide (>= 1024px) and tall (tablets, phones).
 * Static without JS. When the wrapping <Reveal> adds .is-in, lines draw in.
 */

const FORKS = RUN.heads;
const WIN = RUN.winner.id;

/* ---------- Wide ---------- */
const W_Y = [120, 195, 270, 345];
const W_TICKS: number[][] = [
  [474, 514, 550, 586],
  [468, 502, 562],
  [480, 522, 542, 578],
  [466, 500, 534, 574, 612, 650, 692],
];

function Wide() {
  return (
    <svg className={`${s.diagram} ${s.diagramWide}`} viewBox="0 0 1120 410" role="img" aria-labelledby="det-wide-title det-wide-desc">
      <title id="det-wide-title">One detonation</title>
      <desc id="det-wide-desc">
        pid 1, a snapshot of your repo, forks into four children: {FORKS.map((h) => `${h.id} ${h.strategy}`).join(", ")}. They
        race. Fork {WIN} passes the judge first and exits 0 with all {RUN.winner.total} tests passing. The other{" "}
        {RUN.severed} forks get SIGKILL. If no fork passes, the best one seeds the next round.
      </desc>

      {/* next round loop: gate back to pid 1 */}
      <path className={`${s.dLoop} ${s.dFade}`} d="M760 92 V56 Q760 40 744 40 H141 Q125 40 125 56 V194" />
      <path className={`${s.dLoopHead} ${s.dFade}`} d="M119 186 L125 196 L131 186" />
      <text className={`${s.dLabel} ${s.dFade}`} x="160" y="30">
        <tspan className={s.dDim}>no pass? the best fork seeds round 2</tspan>
      </text>

      {/* pid 1 */}
      <rect className={s.dBody} x="40" y="200" width="170" height="64" rx="8" />
      <text className={s.dNodeTitle} x="58" y="227">pid 1</text>
      <text className={s.dNodeSub} x="58" y="247">repo snapshot</text>

      <text className={s.dLabel} x="40" y="298">
        <tspan className={s.dIdx}>01</tspan> FORK
      </text>
      <text className={s.dNodeSub} x="40" y="318">clonefile · {RUN.forkMsEach} ms/fork</text>

      {W_Y.map((y, i) => (
        <path
          key={`f${i}`}
          className={`${s.dFork} ${s.dDraw}`}
          style={{ ["--d" as string]: `${i * 60}ms` }}
          pathLength={1}
          d={`M210 232 C252 232, 248 ${y}, 290 ${y}`}
        />
      ))}

      <text className={s.dLabel} x="456" y="86">
        <tspan className={s.dIdx}>02</tspan> RACE
      </text>
      <text className={s.dLabel} x="604" y="86">
        <tspan className={s.dIdx}>04</tspan> KILL
      </text>

      {FORKS.map((h, i) => {
        const y = W_Y[i];
        const won = h.id === WIN;
        return (
          <g key={h.id}>
            <rect className={won ? s.dForkWin : s.dForkCut} x="290" y={y - 21} width="162" height="42" rx="6" />
            <text className={s.dForkId} x="303" y={y + 5}>
              {h.id}
            </text>
            <text className={s.dForkName} x="348" y={y + 5}>
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
                <path d={`M604 ${y - 8} L620 ${y + 8} M620 ${y - 8} L604 ${y + 8}`} />
                <text className={s.dCutLabel} x="630" y={y + 5}>
                  SIGKILL
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

      {/* exit 0 */}
      <path className={`${s.dLineWin} ${s.dDraw}`} style={{ ["--d" as string]: "900ms" }} pathLength={1} d="M812 345 H870" />
      <g className={s.dFadeLate}>
        <text className={s.dWinLabel} x="870" y="311">
          05 EXIT 0
        </text>
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

/* ---------- Tall (phones, tablets) ---------- */
const T_X = [60, 140, 220, 300];
const T_TICKS: number[][] = [
  [180, 214, 262],
  [176, 206, 270],
  [184, 226, 248, 284],
  [178, 206, 238, 272, 312, 346],
];

function Tall() {
  return (
    <svg className={`${s.diagram} ${s.diagramTall}`} viewBox="0 0 360 540" role="img" aria-labelledby="det-tall-title det-tall-desc">
      <title id="det-tall-title">One detonation</title>
      <desc id="det-tall-desc">
        pid 1 forks into four children. They race. Fork {WIN} passes the judge and exits 0 with {RUN.winner.passed} of{" "}
        {RUN.winner.total} tests passing. Three forks get SIGKILL.
      </desc>

      <path className={`${s.dLoop} ${s.dFade}`} d="M30 395 H22 Q14 395 14 387 V52 Q14 44 22 44 H104" />
      <path className={`${s.dLoopHead} ${s.dFade}`} d="M98 38 L108 44 L98 50" />
      <text className={`${s.dLabelSm} ${s.dFade}`} x="22" y="32">
        <tspan className={s.dDim}>round 2</tspan>
      </text>

      <rect className={s.dBody} x="110" y="20" width="140" height="48" rx="8" />
      <text className={s.dNodeTitle} x="180" y="41" textAnchor="middle">pid 1</text>
      <text className={s.dNodeSubSm} x="180" y="58" textAnchor="middle">repo snapshot</text>
      <text className={s.dLabelSm} x="262" y="38">
        <tspan className={s.dIdx}>01</tspan> FORK
      </text>
      <text className={s.dNodeSubSm} x="262" y="54">{RUN.forkMsEach} ms</text>

      {T_X.map((x, i) => (
        <path
          key={`f${i}`}
          className={`${s.dFork} ${s.dDraw}`}
          style={{ ["--d" as string]: `${i * 60}ms` }}
          pathLength={1}
          d={`M180 68 C180 96, ${x} 92, ${x} 120`}
        />
      ))}

      <text className={s.dLabelSm} x="180" y="276" textAnchor="middle">
        <tspan className={s.dIdx}>02</tspan> RACE
      </text>
      <text className={s.dLabelSm} x="100" y="300" textAnchor="middle">
        <tspan className={s.dIdx}>04</tspan> KILL
      </text>

      {FORKS.map((h, i) => {
        const x = T_X[i];
        const won = h.id === WIN;
        return (
          <g key={h.id}>
            <rect className={won ? s.dForkWin : s.dForkCut} x={x - 34} y="120" width="68" height="34" rx="6" />
            <text className={s.dForkIdSm} x={x} y="142" textAnchor="middle">
              {h.id}
            </text>
            <text className={`${s.dForkNameSm} ${s.dFade}`} transform={`translate(${x + 10} 166) rotate(90)`}>
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
                <path d={`M${x - 8} 308 L${x + 8} 324 M${x + 8} 308 L${x - 8} 324`} />
                <text className={s.dCutLabelSm} x={x} y="344" textAnchor="middle">
                  KILL
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

      <path className={`${s.dLineWin} ${s.dDraw}`} style={{ ["--d" as string]: "900ms" }} pathLength={1} d="M300 420 V452" />
      <g className={s.dFadeLate}>
        <rect className={s.dWin} x="166" y="452" width="178" height="54" rx="8" />
        <text className={s.dWinLabelSm} x="180" y="473">
          05 EXIT 0
        </text>
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

export function DetonationDiagram() {
  return (
    <>
      <Wide />
      <Tall />
    </>
  );
}
