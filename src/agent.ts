import Anthropic from "@anthropic-ai/sdk";
import { BRAND } from "./brand.js";
import type { EventBus } from "./events.js";
import { costOf } from "./pricing.js";
import { HEAD_TOOLS, type Workspace } from "./tools.js";
import type { Semaphore } from "./util.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface TurnRequest {
  system: string;
  messages: BetaMessageParam[];
}

/** The one seam between the CLI and the model. Tests swap in a scripted client. */
export interface ModelClient {
  readonly model: string;
  turn(req: TurnRequest, signal: AbortSignal): Promise<BetaMessage>;
}

/** Models that accept the server-side refusal fallback chain. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
/** Models that return short progress notes between tool calls (thinking display "updates"). */
const NOTES_MODELS = new Set(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5"]);

export class AnthropicModel implements ModelClient {
  private notes: boolean;

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly effort: Effort,
  ) {
    this.notes = NOTES_MODELS.has(model);
  }

  async turn(req: TurnRequest, signal: AbortSignal): Promise<BetaMessage> {
    try {
      return await this.send(req, signal);
    } catch (e) {
      // Progress notes are a nicety; if this account or model rejects them, run without.
      if (this.notes && e instanceof Anthropic.BadRequestError) {
        this.notes = false;
        return this.send(req, signal);
      }
      throw e;
    }
  }

  private async send(req: TurnRequest, signal: AbortSignal): Promise<BetaMessage> {
    const betas: Anthropic.Beta.AnthropicBeta[] = [];
    const fallback = FALLBACK_MODELS.has(this.model);
    if (fallback) betas.push("server-side-fallback-2026-07-01");
    if (this.notes) betas.push("thinking-display-updates-2026-08-18");
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 32_000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: HEAD_TOOLS,
        messages: req.messages,
        output_config: { effort: this.effort },
        cache_control: { type: "ephemeral" },
        ...(this.notes ? { thinking: { type: "adaptive" as const, display: "updates" as const } } : {}),
        ...(fallback ? { fallbacks: "default" as const } : {}),
        ...(betas.length ? { betas } : {}),
      },
      { signal },
    );
    return stream.finalMessage();
  }
}

export interface HeadConfig {
  id: string;
  workspace: Workspace;
  model: ModelClient;
  system: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
  /** Why the signal fired: "severed" by a winner, or the head's own "timeout". */
  abortReason: () => "severed" | "timeout";
  bus: EventBus;
  apiSlots: Semaphore;
}

export interface HeadResult {
  reason: "end_turn" | "max_turns" | "severed" | "refusal" | "timeout" | "error";
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  summary: string;
  error?: string;
}

/** One head: a plain tool-use loop over bash and the text editor, inside its own clone. */
export async function runHead(cfg: HeadConfig): Promise<HeadResult> {
  const { bus, id, signal, workspace } = cfg;
  const messages: BetaMessageParam[] = [{ role: "user", content: cfg.prompt }];
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = 0;
  let summary = "";

  const finish = (reason: HeadResult["reason"], error?: string): HeadResult => ({
    reason,
    turns,
    inputTokens,
    outputTokens,
    costUsd: cost,
    summary,
    ...(error ? { error } : {}),
  });

  try {
    while (true) {
      if (signal.aborted) return finish(cfg.abortReason());
      if (turns >= cfg.maxTurns) return finish("max_turns");
      turns++;

      const release = await cfg.apiSlots.acquire();
      let msg: BetaMessage;
      try {
        if (signal.aborted) return finish(cfg.abortReason());
        msg = await cfg.model.turn({ system: cfg.system, messages }, signal);
      } finally {
        release();
      }

      const u = msg.usage;
      inputTokens += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      outputTokens += u.output_tokens;
      const c = costOf(cfg.model.model, u);
      cost = cost === null || c === null ? null : cost + c;

      for (const b of msg.content) {
        if (b.type === "thinking" && b.thinking.trim()) bus.emit({ type: "note", head: id, text: b.thinking.trim().slice(0, 280) });
        if (b.type === "text" && b.text.trim()) {
          summary = b.text.trim();
          bus.emit({ type: "note", head: id, text: summary.slice(0, 280) });
        }
      }

      // Append-only history: the full assistant turn goes back unchanged.
      messages.push({ role: "assistant", content: msg.content });

      if (msg.stop_reason === "refusal") return finish("refusal");
      if (msg.stop_reason === "pause_turn") continue;

      const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        if (msg.stop_reason === "max_tokens") {
          messages.push({ role: "user", content: "You hit the output limit. Continue, and keep each edit smaller." });
          continue;
        }
        return finish("end_turn");
      }

      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        if (signal.aborted || msg.stop_reason === "max_tokens") {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: signal.aborted ? "aborted" : "This call was cut off by the output limit. Retry it with a smaller input.",
          });
          continue;
        }
        const t0 = performance.now();
        const out =
          use.name === "bash"
            ? await workspace.bash(use.input, signal)
            : use.name === "str_replace_based_edit_tool"
              ? await workspace.edit(use.input)
              : { text: `unknown tool ${use.name}`, isError: true, summary: use.name };
        bus.emit({
          type: "tool",
          head: id,
          tool: use.name === "bash" ? "bash" : "edit",
          summary: out.summary,
          ok: !out.isError,
          ms: Math.round(performance.now() - t0),
        });
        results.push({ type: "tool_result", tool_use_id: use.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (signal.aborted || e instanceof Anthropic.APIUserAbortError) return finish(cfg.abortReason());
    const msg =
      e instanceof Anthropic.APIError ? `API ${e.status ?? ""} ${e.message}`.trim() : e instanceof Error ? e.message : String(e);
    return finish("error", msg);
  }
}

export function systemPrompt(opts: { bashTimeoutS: number; engine: "api" | "claude-code" | "hosted" }): string {
  const fresh = `- bash runs each command in a fresh shell that starts at the repository root, so \`cd\` does not carry over between calls. Chain commands with && when you need to.`;
  const where =
    opts.engine === "api"
      ? `- The repository root is /workspace. Give the text editor paths under /workspace.\n${fresh}`
      : opts.engine === "hosted"
        ? `- The repository root is /workspace. Give the edit tool paths under /workspace.\n${fresh}`
        : `- The repository root is your current working directory. Stay inside it; reads and writes outside it are denied.`;
  return `You are one fork of ${BRAND.name}. Several copies of you are working on the same task at the same time, each in its own private copy of the repository and each with a different strategy. When a fork finishes, the repository's test suite runs on that fork's copy. The first fork to make the suite pass wins, and the others are cut off.

Your workspace
${where}
- There is no network access. Don't try to install packages; work with what is already in the repository.
- Each bash command times out after ${opts.bashTimeoutS} seconds.

Rules
- Test files and test configuration are read-only. Any change to them is reverted before judging, so editing tests can't win.
- .git is read-only.
- Fix the code for real. Don't special-case test inputs, skip tests, or exit early; the diff is reviewed and a run with missing tests doesn't count as a pass.

When you're done
Run the test command yourself to confirm the result. Then reply with two or three sentences on what you changed and why, and stop. If you can't get everything passing, leave the workspace in the best state you reached and say what is still failing.`;
}
