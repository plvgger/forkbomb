"use client";

import { useEffect, useRef } from "react";
import { cx } from "./cx";
import s from "./ForkBombHero.module.css";

/*
 * The hero animation: one process (pid 1) forks 2 → 4 → 8 → 16 → 32 → 64 in a radial
 * tree, a judge sweep SIGKILLs everything off the winning branch, the survivor exits 0,
 * then it loops. It is an illustration (labelled SIM), not a recorded run.
 *
 * - Server-renders a static SVG of the end frame: that is what you see without JS and
 *   under prefers-reduced-motion. The canvas fades in over it once it draws.
 * - Canvas is devicePixelRatio-aware (capped at 2), pauses offscreen / in hidden tabs.
 */

import {
  CTRL,
  DEPTH,
  EXITED,
  KILLED,
  NODE_PX,
  NODES,
  OUTER0,
  RADII,
  TOTAL,
  FORKS,
  TAU,
  lineageOf,
  type ForkNode as Node,
} from "./forkTree";

/* ---------- timeline (ms) ---------- */
const T_FORK = 450;
const LEVEL = 300;
const STAGGER = 150;
const GROW = 240;
const T_SWEEP = 2700;
const SWEEP = 1500;
const T_EXIT = 4380;
const T_FADE = 7700;
const FADE = 500;
const LOOP = 8300;
const FLASH = 170;
const COOL = 520;

const levelStart = (d: number) => T_FORK + (d - 1) * LEVEL;
const bornAt = (n: Node) => (n.d === 0 ? 0 : levelStart(n.d) + (n.i / (1 << n.d)) * STAGGER + GROW);
const angleFrac = (a: number) => ((((a + Math.PI / 2) % TAU) + TAU) % TAU) / TAU;
const BORN = NODES.map(bornAt);

/* ---------- colors ---------- */
const CREAM = "#ece4d4";
const SIGNAL = "#ff4d1f";
const HOT = "#ffb49c";
const OK = "#3cf2b4";
const DEAD = "#34302c";

function mix(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `rgb(${r},${g},${bl})`;
}
/** Keep canvas labels this far inside the stage edge. */
const INSET = 12;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function glowSprite(color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color);
  grad.addColorStop(0.25, color + "88");
  grad.addColorStop(1, color + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/* ---------- static poster (server-rendered) ---------- */
const POSTER_SURVIVOR = OUTER0 + 26; // lower right, so the label fits
const POSTER_LINEAGE = lineageOf(POSTER_SURVIVOR);
const PV = 1000; // viewBox size
const PR = 455; // outer radius in viewBox units
const px = (v: number) => (PV / 2 + v * PR).toFixed(1);

function Poster() {
  const sv = NODES[POSTER_SURVIVOR];
  const labelRight = Math.cos(sv.a) >= 0;
  const lx = PV / 2 + sv.x * PR + (labelRight ? 22 : -22);
  const ly = PV / 2 + sv.y * PR;
  return (
    <svg className={s.poster} viewBox={`0 0 ${PV} ${PV}`} aria-hidden="true" focusable="false">
      <g fill="none" stroke="var(--text)" strokeOpacity="0.06">
        {RADII.slice(1).map((r) => (
          <circle key={r} cx={PV / 2} cy={PV / 2} r={r * PR} />
        ))}
      </g>
      <g fill="none" strokeLinecap="round">
        {NODES.slice(1).map((n) => {
          const p = NODES[n.parent];
          const c = CTRL[n.idx];
          const live = POSTER_LINEAGE.has(n.idx);
          return (
            <path
              key={n.idx}
              d={`M${px(p.x)} ${px(p.y)}Q${px(c[0])} ${px(c[1])} ${px(n.x)} ${px(n.y)}`}
              stroke={live ? OK : CREAM}
              strokeOpacity={live ? 0.95 : 0.1}
              strokeWidth={live ? 3.2 : 1.4}
            />
          );
        })}
      </g>
      <g>
        {NODES.map((n) => {
          const live = POSTER_LINEAGE.has(n.idx);
          const h = NODE_PX[n.d] * (live ? 1.5 : 1.15);
          const color = n.d === 0 ? CREAM : live ? OK : DEAD;
          return (
            <rect
              key={n.idx}
              x={(PV / 2 + n.x * PR - h).toFixed(1)}
              y={(PV / 2 + n.y * PR - h).toFixed(1)}
              width={(h * 2).toFixed(1)}
              height={(h * 2).toFixed(1)}
              fill={color}
            />
          );
        })}
        <circle cx={px(sv.x)} cy={px(sv.y)} r="26" fill={OK} fillOpacity="0.16" />
      </g>
      <g fontFamily="var(--font-mono)" fontSize="26" fontWeight="600">
        <text x={PV / 2} y={PV / 2 + 44} textAnchor="middle" fill="var(--text-2)">
          pid 1
        </text>
        <text x={lx} y={ly - 4} textAnchor={labelRight ? "start" : "end"} fill={OK}>
          exit 0
        </text>
        <text x={lx} y={ly + 26} textAnchor={labelRight ? "start" : "end"} fill="var(--text-2)" fontWeight="400">
          pid {sv.pid}
        </text>
      </g>
    </svg>
  );
}

/* ---------- component ---------- */
export function ForkBombHero({
  className,
  label = "Animation: one process forks into 126 copies, a judge kills every branch but one, and the single survivor exits 0.",
  hud = true,
}: {
  className?: string;
  /** Accessible description of the animation. */
  label?: string;
  /** Show the counters and status line. */
  hud?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const forksRef = useRef<HTMLElement>(null);
  const killedRef = useRef<HTMLElement>(null);
  const exitRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!root || !stage || !canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mono = getComputedStyle(root).fontFamily || "ui-monospace, monospace";
    const sprites = {
      signal: glowSprite(SIGNAL),
      ok: glowSprite(OK),
      cream: glowSprite("#ffe6c8"),
    };

    let W = 0;
    let H = 0;
    let dpr = 1;
    let R = 0;
    let cx = 0;
    let cy = 0;
    let k = 1; // node scale

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const m = Math.min(W, H);
      R = m / 2 - Math.max(16, m * 0.05);
      cx = W / 2;
      cy = H / 2;
      k = Math.max(0.62, Math.min(1.5, R / 280));
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (!running) draw(clock);
    });
    ro.observe(stage);

    // Per-loop state
    let survivor = OUTER0 + Math.floor(Math.random() * (1 << DEPTH));
    let lineage = lineageOf(survivor);
    let killAt = new Float64Array(TOTAL);
    let labels: number[] = [];
    const plan = () => {
      for (const n of NODES) killAt[n.idx] = lineage.has(n.idx) ? Infinity : T_SWEEP + SWEEP * angleFrac(n.a);
      const off = Math.floor(Math.random() * 10);
      labels = [];
      for (let j = 0; j < 6; j++) {
        const idx = OUTER0 + ((off + j * 11) % (1 << DEPTH));
        if (Math.abs(idx - survivor) > 2) labels.push(idx);
      }
    };
    plan();

    let clock = 0;
    let loopIndex = 0;
    let last = 0;
    let raf = 0;
    let running = false;
    let visible = false;
    let shown = false;
    const hudVals = { forks: -1, killed: -1, exit: -1, status: "" };

    const setText = (el: HTMLElement | null, key: "forks" | "killed" | "exit", v: number) => {
      if (el && hudVals[key] !== v) {
        hudVals[key] = v;
        el.textContent = String(v);
      }
    };
    const setStatus = (text: string) => {
      if (statusRef.current && hudVals.status !== text) {
        hudVals.status = text;
        statusRef.current.textContent = text;
      }
    };

    const P = (nx: number, ny: number): [number, number] => [cx + nx * R, cy + ny * R];

    function quadPoint(n: Node, t: number): [number, number] {
      const p = NODES[n.parent];
      const c = CTRL[n.idx];
      const u = 1 - t;
      return [u * u * p.x + 2 * u * t * c[0] + t * t * n.x, u * u * p.y + 2 * u * t * c[1] + t * t * n.y];
    }

    function draw(t: number) {
      const c = ctx!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);

      const fade = t > T_FADE ? 1 - clamp01((t - T_FADE) / FADE) : 1;
      c.globalAlpha = fade;

      // Orbit guides
      c.lineWidth = 1;
      c.strokeStyle = "rgba(236,228,212,0.05)";
      for (let d = 1; d <= DEPTH; d++) {
        c.beginPath();
        c.arc(cx, cy, RADII[d] * R, 0, TAU);
        c.stroke();
      }

      // Shockwave per fork level
      for (let d = 1; d <= DEPTH; d++) {
        const st = levelStart(d);
        const p = (t - st) / 520;
        if (p > 0 && p < 1) {
          const r = (RADII[d - 1] + (RADII[d] * 1.08 - RADII[d - 1]) * easeOut(p)) * R;
          c.strokeStyle = `rgba(255,77,31,${0.4 * (1 - p)})`;
          c.lineWidth = 2 * k;
          c.beginPath();
          c.arc(cx, cy, r, 0, TAU);
          c.stroke();
        }
      }

      // Judge sweep (radar wedge)
      const sp = (t - T_SWEEP) / SWEEP;
      if (sp > -0.02 && sp < 1.06) {
        const sa = -Math.PI / 2 + clamp01(sp) * TAU;
        const span = 0.9;
        const alpha = sp > 1 ? Math.max(0, 1 - (sp - 1) / 0.06) : 1;
        const cg = (c as CanvasRenderingContext2D & { createConicGradient?: unknown }).createConicGradient
          ? c.createConicGradient(sa - span, cx, cy)
          : null;
        if (cg) {
          cg.addColorStop(0, "rgba(255,77,31,0)");
          cg.addColorStop(span / TAU, `rgba(255,77,31,${0.2 * alpha})`);
          cg.addColorStop(span / TAU + 0.0001, "rgba(255,77,31,0)");
          cg.addColorStop(1, "rgba(255,77,31,0)");
          c.fillStyle = cg;
          c.beginPath();
          c.moveTo(cx, cy);
          c.arc(cx, cy, R * 1.02, sa - span, sa);
          c.closePath();
          c.fill();
        }
        c.strokeStyle = `rgba(255,120,80,${0.75 * alpha})`;
        c.lineWidth = 1.5 * k;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(sa) * R * 1.02, cy + Math.sin(sa) * R * 1.02);
        c.stroke();
      }

      // Edges
      c.lineCap = "round";
      let forks = 0;
      let killed = 0;
      for (let j = 1; j < TOTAL; j++) {
        const n = NODES[j];
        const born = BORN[j];
        const g = clamp01((t - (born - GROW)) / GROW);
        if (g <= 0) continue;
        if (g >= 1) forks++;
        const kt = killAt[j];
        const lit = lineage.has(j) && t > T_EXIT + n.d * 70;
        let stroke: string;
        let w = 1.1 * k;
        if (lit) {
          stroke = OK;
          w = 2.2 * k;
          c.globalAlpha = fade;
        } else if (t >= kt) {
          const q = clamp01((t - kt) / COOL);
          stroke = q < 0.3 ? SIGNAL : DEAD;
          c.globalAlpha = fade * (q < 0.3 ? 0.9 : 0.55);
        } else {
          const fresh = clamp01((t - born) / 380);
          stroke = g < 1 || fresh < 1 ? mix(SIGNAL, CREAM, fresh) : CREAM;
          c.globalAlpha = fade * (g < 1 ? 0.85 : 0.85 - 0.62 * fresh);
        }
        c.strokeStyle = stroke;
        c.lineWidth = w;
        const p = NODES[n.parent];
        const [x0, y0] = P(p.x, p.y);
        c.beginPath();
        c.moveTo(x0, y0);
        if (g >= 1) {
          const cc = CTRL[j];
          const [qx, qy] = P(cc[0], cc[1]);
          const [x1, y1] = P(n.x, n.y);
          c.quadraticCurveTo(qx, qy, x1, y1);
        } else {
          const steps = 10;
          for (let sIdx = 1; sIdx <= steps; sIdx++) {
            const [qx, qy] = quadPoint(n, (g * sIdx) / steps);
            const [x1, y1] = P(qx, qy);
            c.lineTo(x1, y1);
          }
        }
        c.stroke();
      }
      c.globalAlpha = fade;

      // Nodes
      let lastPid = 1;
      for (let j = 0; j < TOTAL; j++) {
        const n = NODES[j];
        const born = BORN[j];
        if (t < born) continue;
        const [x, y] = P(n.x, n.y);
        const kt = killAt[j];
        let h = NODE_PX[n.d] * k;
        let color = CREAM;
        let sprite: HTMLCanvasElement | null = null;
        let spriteScale = 0;
        const age = t - born;
        if (n.d > 0) lastPid = Math.max(lastPid, n.pid);
        if (j === 0 && t < 400) {
          const p = easeOut(clamp01(t / 400));
          h *= 0.4 + 0.6 * p;
          sprite = sprites.signal;
          spriteScale = 7 * (1 - p) + 3;
        }
        if (lineage.has(j) && t > T_EXIT + n.d * 70) {
          color = OK;
          h *= 1.25;
          if (j === survivor) {
            const pulse = 0.5 + 0.5 * Math.sin((t - T_EXIT) / 160);
            h = NODE_PX[3] * k * (1.5 + 0.25 * pulse);
            sprite = sprites.ok;
            spriteScale = 7 + 2 * pulse;
          }
        } else if (t >= kt) {
          killed++;
          const q = t - kt;
          if (q < FLASH) {
            color = HOT;
            h *= 1.9;
            sprite = sprites.signal;
            spriteScale = 6;
          } else if (q < FLASH + COOL) {
            const z = (q - FLASH) / COOL;
            color = mix(SIGNAL, DEAD, z);
            h *= 1.9 - 1.1 * z;
          } else {
            color = DEAD;
            h *= 0.8;
          }
        } else if (age < 220 && n.d > 0) {
          color = mix(HOT, CREAM, age / 220);
          h *= 1.6 - 0.6 * (age / 220);
          sprite = sprites.signal;
          spriteScale = 4.5 * (1 - age / 220);
        }
        if (sprite && spriteScale > 0) {
          const sz = h * spriteScale * 2;
          c.drawImage(sprite, x - sz / 2, y - sz / 2, sz, sz);
        }
        c.fillStyle = color;
        c.fillRect(
          Math.round(x - h),
          Math.round(y - h),
          Math.max(1, Math.round(h * 2)),
          Math.max(1, Math.round(h * 2)),
        );
      }

      // Survivor shock ring
      if (t > T_EXIT + DEPTH * 70) {
        const p = ((t - T_EXIT - DEPTH * 70) % 1400) / 1400;
        const sv = NODES[survivor];
        const [x, y] = P(sv.x, sv.y);
        c.strokeStyle = `rgba(60,242,180,${0.55 * (1 - p)})`;
        c.lineWidth = 1.5 * k;
        c.beginPath();
        c.arc(x, y, (6 + 26 * easeOut(p)) * k, 0, TAU);
        c.stroke();
      }

      // Text
      const fs = Math.round(Math.max(10, Math.min(14, 11 * k)));
      c.font = `600 ${fs}px ${mono}`;
      c.textBaseline = "middle";

      // SIGKILL labels (too small to read on phones, so skipped under 480px)
      for (const idx of W < 480 ? [] : labels) {
        const kt = killAt[idx];
        const q = (t - kt) / 900;
        if (q <= 0 || q >= 1) continue;
        const n = NODES[idx];
        const out = R * (1 + 0.02 + 0.06 * q);
        let lx = cx + Math.cos(n.a) * out;
        const ly = cy + Math.sin(n.a) * out;
        const right = Math.cos(n.a) >= 0;
        c.textAlign = right ? "left" : "right";
        const tw = c.measureText("SIGKILL").width;
        lx = right ? Math.min(lx, W - tw - INSET) : Math.max(lx, tw + INSET);
        c.globalAlpha = fade * (1 - q);
        c.fillStyle = SIGNAL;
        c.fillText("SIGKILL", lx, Math.max(fs, Math.min(H - fs, ly)));
      }
      c.globalAlpha = fade;

      // pid 1 label
      c.textAlign = "center";
      c.fillStyle = "rgba(236,228,212,0.72)";
      c.font = `500 ${fs}px ${mono}`;
      c.fillText("pid 1", cx, cy + 16 * k + fs * 0.5);

      // Survivor label
      if (t > T_EXIT + DEPTH * 70) {
        const sv = NODES[survivor];
        const [x, y] = P(sv.x, sv.y);
        const appear = clamp01((t - T_EXIT - DEPTH * 70) / 250);
        c.globalAlpha = fade * appear;
        c.font = `700 ${fs + 2}px ${mono}`;
        const l1 = "exit 0";
        const l2 = `pid ${sv.pid}`;
        const tw = Math.max(c.measureText(l1).width, c.measureText(l2).width);
        const gap = 14 * k;
        // Outward side first; flip inward when the label would run off the stage.
        let right = Math.cos(sv.a) >= 0;
        if (right && x + gap + tw > W - INSET) right = false;
        else if (!right && x - gap - tw < INSET) right = true;
        let lx = x + (right ? gap : -gap);
        lx = right ? Math.min(lx, W - tw - INSET) : Math.max(lx, tw + INSET);
        let ly = y - fs * 0.4;
        ly = Math.max(fs + INSET, Math.min(H - fs * 2 - INSET, ly));
        c.textAlign = right ? "left" : "right";
        c.fillStyle = "rgba(10,10,11,0.78)";
        c.fillRect(right ? lx - 4 : lx - tw - 4, ly - fs, tw + 8, fs * 2 + 10);
        c.fillStyle = OK;
        c.fillText(l1, lx, ly);
        c.font = `500 ${fs}px ${mono}`;
        c.fillStyle = "rgba(236,228,212,0.8)";
        c.fillText(l2, lx, ly + fs + 3);
      }
      c.globalAlpha = 1;

      // HUD
      setText(forksRef.current, "forks", forks);
      setText(killedRef.current, "killed", killed);
      // Only the survivor exits 0. The green path above it is its parents, which are neither killed nor exits.
      const exited = t > T_EXIT + DEPTH * 70;
      setText(exitRef.current, "exit", exited ? EXITED : 0);
      if (t < T_FORK) setStatus("$ :(){ :|:& };:");
      else if (forks < FORKS) setStatus(`fork() → pid ${lastPid}`);
      else if (t < T_SWEEP) setStatus(`${TOTAL} procs · judge: running tests`);
      else if (!exited) setStatus(`kill -9 · ${killed} forks`);
      else setStatus(`pid ${NODES[survivor].pid} exit 0 · patch kept`);
    }

    const frame = (now: number) => {
      raf = 0;
      if (!running) return;
      const dt = last ? Math.min(50, now - last) : 16;
      last = now;
      clock += dt;
      if (clock >= LOOP) {
        clock = 0;
        loopIndex++;
        survivor = OUTER0 + Math.floor(Math.random() * (1 << DEPTH));
        lineage = lineageOf(survivor);
        plan();
      }
      draw(clock);
      if (!shown) {
        shown = true;
        root.dataset.live = "";
      }
      raf = requestAnimationFrame(frame);
    };

    const update = () => {
      const should = visible && !document.hidden;
      if (should && !running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        update();
      },
      { threshold: 0.05 },
    );
    io.observe(stage);
    document.addEventListener("visibilitychange", update);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", update);
      void loopIndex;
      killAt = new Float64Array(0);
    };
  }, []);

  return (
    <div ref={rootRef} className={cx(s.root, className)} role="img" aria-label={label}>
      {hud && (
        <div className={s.hud} aria-hidden="true">
          <span className={s.stat}>
            <span className={s.k}>fork()</span>
            <b ref={forksRef}>{FORKS}</b>
          </span>
          <span className={cx(s.stat, s.statKill)}>
            <span className={s.k}>SIGKILL</span>
            <b ref={killedRef}>{KILLED}</b>
          </span>
          <span className={cx(s.stat, s.statOk)}>
            <span className={s.k}>exit 0</span>
            <b ref={exitRef}>{EXITED}</b>
          </span>
        </div>
      )}
      <div ref={stageRef} className={s.stage}>
        <Poster />
        <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
      </div>
      {hud && (
        <div className={s.status} aria-hidden="true">
          <span ref={statusRef}>pid {NODES[POSTER_SURVIVOR].pid} exit 0 · patch kept</span>
          <span className={s.sim} title="Illustration, not a recorded run">
            sim
          </span>
        </div>
      )}
    </div>
  );
}
