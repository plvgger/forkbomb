import type { ChatCompletion, ToolCall } from "./hosted.js";

/**
 * Reads a streamed Chat Completions answer (server-sent events) back into the one ChatCompletion a
 * non-streaming call would have returned. Pure: no I/O, so every chunk boundary can be tested directly.
 */

/** The gateway's settlement figures: response headers on a JSON answer, a comment before [DONE] on a stream. */
export const HEADER_COST = "x-request-cost-usd";
export const HEADER_REMAINING = "x-credits-remaining-usd";

/** One complete SSE item: an event's joined data lines, or a comment line (": keep-alive"). */
export type SseItem = { data: string } | { comment: string };

/**
 * Minimal SSE parser: feed decoded text, get back complete items. Handles events split across reads,
 * several events per read, and \n, \r\n or \r line endings. Comments come out as soon as their line ends.
 */
export class SseParser {
  #buf = "";
  #data: string[] = [];

  push(text: string): SseItem[] {
    this.#buf += text;
    // A trailing "\r" may be the first half of "\r\n": hold it until the next read.
    const hold = this.#buf.endsWith("\r") ? 1 : 0;
    const lines = this.#buf.slice(0, this.#buf.length - hold).split(/\r\n|\r|\n/);
    this.#buf = lines.pop()! + this.#buf.slice(this.#buf.length - hold);
    const out: SseItem[] = [];
    for (const line of lines) {
      if (line === "") {
        if (this.#data.length) out.push({ data: this.#data.join("\n") });
        this.#data = [];
      } else if (line.startsWith(":")) {
        out.push({ comment: line.slice(1).trim() });
      } else if (line === "data" || line.startsWith("data:")) {
        this.#data.push(line.slice(5).replace(/^ /, ""));
      }
      // event:, id: and retry: carry nothing a chat completion needs.
    }
    return out;
  }

  /** The stream ended: a last line or event missing its line break still counts (truncated JSON fails to parse later). */
  end(): SseItem[] {
    return this.push("\n\n");
  }
}

/** The OpenAI error shape {"error":{"message","type","code"}}; code falls back to type, as the gateway's HTTP errors are read. */
export function errorFields(body: unknown): { message: string; code: string; type: string } | null {
  const e = (body as { error?: unknown } | null)?.error;
  if (!e || typeof e !== "object") return null;
  const { message, code, type } = e as { message?: unknown; code?: unknown; type?: unknown };
  const t = typeof type === "string" ? type : "";
  return { message: typeof message === "string" ? message : "", code: typeof code === "string" ? code : t, type: t };
}

/** Reasoning is only shown as a short note; this much is plenty and bounds memory on long thoughts. */
const MAX_REASONING = 4096;

interface Choice {
  content: string;
  reasoning: string;
  /** By the index the server gave each call. */
  calls: Map<number, { id: string; name: string; arguments: string }>;
  finish: string | null;
}

/**
 * Builds one ChatCompletion from chat.completion.chunk events: content and reasoning deltas concatenate,
 * tool calls assemble by index (id and name arrive first, arguments stream in pieces, several calls in
 * parallel), the last usage chunk wins, and the gateway's settled cost comes from the comment it sends
 * just before [DONE].
 */
export class ChatAssembler {
  /** Saw data: [DONE]. */
  done = false;
  /** Settled cost from the gateway's final comment (x-request-cost-usd), or null if it never came. */
  costUsd: number | null = null;
  /** Spendable balance after settling, from the same comment (x-credits-remaining-usd). */
  remainingUsd: number | null = null;
  #id: string | undefined;
  #model: string | undefined;
  #usage: ChatCompletion["usage"];
  readonly #choices = new Map<number, Choice>();

  /** At least one choice said why it stopped, so the answer is whole even without [DONE]. */
  get finished(): boolean {
    for (const c of this.#choices.values()) if (c.finish !== null) return true;
    return false;
  }

  /** Some choice arrived: an answer the server started, which is whole only once finished. */
  get started(): boolean {
    return this.#choices.size > 0;
  }

  /** The model produced something: content, reasoning or a tool call (a bare role delta does not count). */
  get generated(): boolean {
    for (const c of this.#choices.values()) if (c.content || c.reasoning || c.calls.size) return true;
    return false;
  }

  /** Takes one data event. Returns the error an error event carries; anything that is not a JSON object is skipped. */
  event(data: string): { message: string; code: string; type: string } | null {
    if (data.trim() === "[DONE]") {
      this.done = true;
      return null;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    if (obj.error) return errorFields(obj) ?? { message: "", code: "", type: "" };
    if (typeof obj.id === "string") this.#id ??= obj.id;
    if (typeof obj.model === "string") this.#model ??= obj.model;
    if (obj.usage && typeof obj.usage === "object") this.#usage = obj.usage as ChatCompletion["usage"];
    if (Array.isArray(obj.choices)) {
      obj.choices.forEach((raw: unknown, i) => this.#delta(raw, i));
    }
    return null;
  }

  /** Takes one comment line; only the gateway's settlement comment means anything. */
  comment(text: string): void {
    const cost = field(text, HEADER_COST);
    if (cost !== null && cost >= 0) this.costUsd = cost;
    const left = field(text, HEADER_REMAINING);
    if (left !== null) this.remainingUsd = left;
  }

  completion(): ChatCompletion {
    const choices = [...this.#choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        const calls: Partial<ToolCall>[] = [...c.calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, t]) => ({ ...(t.id ? { id: t.id } : {}), type: "function" as const, function: { name: t.name, arguments: t.arguments } }));
        return {
          index,
          message: {
            role: "assistant" as const,
            // As a non-streaming answer has it: null when the turn was only tool calls.
            content: c.content || null,
            ...(calls.length ? { tool_calls: calls } : {}),
            ...(c.reasoning ? { reasoning_content: c.reasoning } : {}),
          },
          finish_reason: c.finish,
        };
      });
    return {
      ...(this.#id ? { id: this.#id } : {}),
      ...(this.#model ? { model: this.#model } : {}),
      choices,
      ...(this.#usage ? { usage: this.#usage } : {}),
    };
  }

  #delta(raw: unknown, position: number): void {
    if (!raw || typeof raw !== "object") return;
    const r = raw as { index?: unknown; delta?: unknown; finish_reason?: unknown };
    const index = Number.isInteger(r.index) ? (r.index as number) : position;
    let c = this.#choices.get(index);
    if (!c) this.#choices.set(index, (c = { content: "", reasoning: "", calls: new Map(), finish: null }));
    if (typeof r.finish_reason === "string" && r.finish_reason) c.finish = r.finish_reason;
    const d = (r.delta && typeof r.delta === "object" ? r.delta : {}) as {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: unknown;
    };
    if (typeof d.content === "string") c.content += d.content;
    // Some servers send the same thought under both names: take one, never both.
    const thought = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof d.reasoning === "string" ? d.reasoning : "";
    if (thought && c.reasoning.length < MAX_REASONING) c.reasoning = (c.reasoning + thought).slice(0, MAX_REASONING);
    if (!Array.isArray(d.tool_calls)) return;
    d.tool_calls.forEach((rawCall: unknown, i) => {
      if (!rawCall || typeof rawCall !== "object") return;
      const t = rawCall as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } | null };
      const at = Number.isInteger(t.index) ? (t.index as number) : i;
      let call = c.calls.get(at);
      if (!call) c.calls.set(at, (call = { id: "", name: "", arguments: "" }));
      // id and name come whole in the first delta of a call (a repeat replaces); arguments arrive in pieces.
      if (typeof t.id === "string" && t.id) call.id = t.id;
      if (typeof t.function?.name === "string" && t.function.name) call.name = t.function.name;
      if (typeof t.function?.arguments === "string") call.arguments += t.function.arguments;
    });
  }
}

/** "x-request-cost-usd=0.001234 x-credits-remaining-usd=4.998766" -> the named number, or null. */
function field(text: string, name: string): number | null {
  const m = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
