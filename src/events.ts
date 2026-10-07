import { appendFileSync } from "node:fs";

export type RunEvent =
  | {
      type: "run_start";
      runId: string;
      task: string;
      testCmd: string;
      forks: number;
      rounds: number;
      model: string;
      engine: "api" | "claude-code" | "hosted";
      effort: string;
      mode: "race" | "best";
      repo: string;
      forker: string;
      sandbox: boolean;
      network: boolean;
    }
  | { type: "baseline"; passed: number | null; failed: number | null; exitCode: number | null; score: number; outputTail: string }
  | {
      type: "fork";
      round: number;
      parent: string;
      forks: string[];
      msEach: number[];
      workspaceBytes: number;
      logicalBytes: number;
      physicalBytes: number | null;
      forker: string;
    }
  | { type: "fork_start"; fork: string; round: number; parent: string; strategy: string; brief: string }
  | { type: "tool"; fork: string; tool: "bash" | "edit"; summary: string; ok: boolean; ms: number }
  | { type: "note"; fork: string; text: string }
  | {
      type: "fork_done";
      fork: string;
      reason: "end_turn" | "max_turns" | "killed" | "refusal" | "timeout" | "error";
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      summary: string;
      error?: string;
    }
  | { type: "judging"; fork: string }
  | {
      type: "judge";
      fork: string;
      passed: number | null;
      failed: number | null;
      exitCode: number | null;
      score: number;
      diffLines: number;
      filesChanged: number;
      tampered: string[];
      outputTail: string;
    }
  | { type: "kill"; fork: string; why: string }
  | { type: "round_end"; round: number; best: string | null; bestScore: number }
  | { type: "winner"; fork: string; round: number; score: number; diffLines: number; filesChanged: number; patch: string; summary: string }
  | { type: "run_end"; ok: boolean; ms: number; costUsd: number | null; applied: boolean; patchPath: string | null; best: string | null; bestScore: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

export type Stamped = RunEvent & { t: number };

/**
 * Fields the replay viewer and the narration read from each event type. Typed
 * against the union, so a new event type can't be added without its entry.
 */
const REQUIRED: { readonly [K in RunEvent["type"]]: readonly (keyof Extract<RunEvent, { type: K }>)[] } = {
  run_start: ["runId", "forks", "rounds", "engine", "mode"],
  baseline: ["score"],
  fork: ["round", "parent", "forks", "msEach"],
  fork_start: ["fork", "parent", "strategy"],
  tool: ["fork", "tool", "summary"],
  note: ["fork", "text"],
  fork_done: ["fork", "reason"],
  judging: ["fork"],
  judge: ["fork", "score"],
  kill: ["fork", "why"],
  round_end: ["round", "bestScore"],
  winner: ["fork", "patch"],
  run_end: ["ok", "ms"],
  log: ["level", "msg"],
};

/**
 * Parse an events.jsonl. Throws on the first line that isn't JSON, has an
 * event type this version doesn't write, or lacks a field the viewer needs, so
 * `replay` and `export` refuse a log instead of serving half a run.
 */
export function parseEventLog(text: string): Stamped[] {
  const out: Stamped[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const at = `line ${i + 1}`;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${at} is not JSON`);
    }
    const kind = String(e?.type);
    const need = Object.hasOwn(REQUIRED, kind) ? (REQUIRED[kind as RunEvent["type"]] as readonly string[]) : null;
    if (!need) throw new Error(`${at}: unknown event type "${kind}"`);
    const missing = [...need, "t"].filter((k) => e[k] === undefined);
    if (missing.length) throw new Error(`${at}: ${kind} event without ${missing.join(", ")}`);
    out.push(e as Stamped);
  });
  return out;
}

type Listener = (e: Stamped) => void;

/** Every state change in a run is an event: written to events.jsonl, streamed to the UI. */
export class EventBus {
  readonly history: Stamped[] = [];
  private listeners = new Set<Listener>();
  private readonly t0 = performance.now();

  constructor(private readonly file?: string) {}

  emit(e: RunEvent): void {
    const s = { ...e, t: Math.round(performance.now() - this.t0) } as Stamped;
    this.history.push(s);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(s)}\n`);
    for (const l of this.listeners) l(s);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
