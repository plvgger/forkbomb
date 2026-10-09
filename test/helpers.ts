import type Anthropic from "@anthropic-ai/sdk";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelClient, TurnRequest } from "../src/agent.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type Block = BetaMessage["content"][number];

/** A temp dir inside the project's .test-tmp (same APFS volume, nothing written outside the repo). */
export function tempDir(prefix: string): string {
  const base = join(process.cwd(), ".test-tmp", "work");
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, `${prefix}-`)));
}

/**
 * A stand-in `claude` binary (test/fake-claude.mjs) that plays `scripts`, picked by the strategy in the prompt.
 * The engine hands claude an allowlisted env, so the config is baked into a wrapper script. Calls go to `log`.
 */
export function fakeClaude(scripts: Record<string, unknown[]>): { work: string; bin: string; log: string } {
  const work = tempDir("fake-claude");
  const scriptFile = join(work, "scripts.json");
  const log = join(work, "calls.jsonl");
  writeFileSync(scriptFile, JSON.stringify(scripts));
  const bin = join(work, "claude");
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const fake = join(process.cwd(), "test", "fake-claude.mjs");
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_SCRIPTS=${q(scriptFile)} FAKE_CLAUDE_LOG=${q(log)} exec ${q(process.execPath)} ${q(fake)} "$@"\n`);
  chmodSync(bin, 0o755);
  return { work, bin, log };
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
}

let seq = 0;
export function message(content: Block[], stop: BetaMessage["stop_reason"] = "end_turn"): BetaMessage {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as BetaMessage;
}

export function toolUse(name: "bash" | "str_replace_based_edit_tool", input: Record<string, unknown>): Block {
  return { type: "tool_use", id: `tu_${++seq}`, name, input } as unknown as Block;
}

export function text(t: string): Block {
  return { type: "text", text: t, citations: null } as unknown as Block;
}

export type Script = Array<BetaMessage | ((req: TurnRequest) => BetaMessage)>;

/**
 * Scripted model: picks a script by the strategy named in the fork's prompt
 * and plays it one turn at a time. `delayMs` simulates a slow model.
 */
export class FakeModel implements ModelClient {
  readonly model = "fake-model";
  constructor(
    private readonly scripts: Record<string, Script>,
    private readonly delayMs: Record<string, number> = {},
  ) {}

  async turn(req: TurnRequest, signal: AbortSignal): Promise<BetaMessage> {
    const prompt = String(req.messages[0]?.content ?? "");
    const strategy = /Your strategy \(([^)]+)\)/.exec(prompt)?.[1] ?? "";
    const script = this.scripts[strategy] ?? this.scripts["*"] ?? [];
    const turn = req.messages.filter((m) => m.role === "assistant").length;
    const delay = this.delayMs[strategy] ?? 0;
    if (delay) {
      await new Promise<void>((done, fail) => {
        const t = setTimeout(done, delay);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    if (signal.aborted) throw new Error("aborted");
    const step = script[turn] ?? message([text("done")]);
    return typeof step === "function" ? step(req) : step;
  }
}
