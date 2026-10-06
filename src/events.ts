import { appendFileSync } from "node:fs";

export type ForkbombEvent =
  | {
      type: "run_start";
      runId: string;
      task: string;
      testCmd: string;
      heads: number;
      rounds: number;
      model: string;
      engine: "api" | "claude-code";
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
      heads: string[];
      msEach: number[];
      workspaceBytes: number;
      logicalBytes: number;
      physicalBytes: number | null;
      forker: string;
    }
  | { type: "head_start"; head: string; round: number; parent: string; strategy: string; brief: string }
  | { type: "tool"; head: string; tool: "bash" | "edit"; summary: string; ok: boolean; ms: number }
  | { type: "note"; head: string; text: string }
  | {
      type: "head_done";
      head: string;
      reason: "end_turn" | "max_turns" | "severed" | "refusal" | "timeout" | "error";
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      summary: string;
      error?: string;
    }
  | { type: "judging"; head: string }
  | {
      type: "judge";
      head: string;
      passed: number | null;
      failed: number | null;
      exitCode: number | null;
      score: number;
      diffLines: number;
      filesChanged: number;
      tampered: string[];
      outputTail: string;
    }
  | { type: "sever"; head: string; why: string }
  | { type: "round_end"; round: number; best: string | null; bestScore: number }
  | { type: "winner"; head: string; round: number; score: number; diffLines: number; filesChanged: number; patch: string; summary: string }
  | { type: "run_end"; ok: boolean; ms: number; costUsd: number | null; applied: boolean; patchPath: string | null; best: string | null; bestScore: number }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

export type Stamped = ForkbombEvent & { t: number };

type Listener = (e: Stamped) => void;

/** Every state change in a run is an event: written to events.jsonl, streamed to the UI. */
export class EventBus {
  readonly history: Stamped[] = [];
  private listeners = new Set<Listener>();
  private readonly t0 = performance.now();

  constructor(private readonly file?: string) {}

  emit(e: ForkbombEvent): void {
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
