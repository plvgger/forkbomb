// Turns a client Chat Completions body into the body sent upstream, and bounds what it can cost.
// The bound is what gets reserved: estimated input tokens plus max_tokens, which is always sent upstream
// so the model can never generate more output than was paid for up front.

import { ApiError } from "../http";

/** Output cap when the client sends no max_tokens. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Larger requests are clamped to this. */
export const MAX_OUTPUT_TOKENS = 32_768;
/** Vercel caps request bodies at 4.5 MB. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGES = 2048;
/** Conservative: code and English run ~4 bytes per token, so 3 over-reserves. CJK is ~3 bytes per char and token. */
export const BYTES_PER_TOKEN = 3;
const PER_MESSAGE_TOKENS = 8;
const BASE_TOKENS = 16;

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

/** Optional fields forwarded as-is. Everything else (model, n, logprobs, user, ...) is dropped. */
const PASSTHROUGH = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "response_format",
] as const;

export type ChatRequest = {
  stream: boolean;
  /** The client asked for the final usage chunk of a stream (stream_options.include_usage). */
  includeUsage: boolean;
  maxTokens: number;
  estimatedInputTokens: number;
  /** Upstream body without model, stream and stream_options, which the gateway sets. */
  body: Record<string, unknown>;
};

const bad = (code: string, message: string) => new ApiError(400, code, message);

export const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Validates the shape the gateway depends on. Deeper validation is left to the upstream server. */
export function parseChatRequest(raw: Record<string, unknown>): ChatRequest {
  const { messages } = raw;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad("invalid_messages", "messages must be a non-empty array.");
  }
  if (messages.length > MAX_MESSAGES) throw bad("invalid_messages", `At most ${MAX_MESSAGES} messages.`);
  messages.forEach((m: unknown, i) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw bad("invalid_messages", `messages[${i}] must be an object.`);
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw bad("invalid_messages", `messages[${i}].role must be one of ${[...ROLES].join(", ")}.`);
    }
    if (content !== undefined && content !== null && typeof content !== "string" && !Array.isArray(content)) {
      throw bad("invalid_messages", `messages[${i}].content must be a string, an array of parts, or null.`);
    }
  });
  if (raw.tools !== undefined && !Array.isArray(raw.tools)) throw bad("invalid_tools", "tools must be an array.");
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") throw bad("invalid_stream", "stream must be a boolean.");
  if (raw.n !== undefined && raw.n !== 1) throw bad("unsupported_n", "Only n = 1 is supported.");

  const maxTokens = parseMaxTokens(raw.max_completion_tokens ?? raw.max_tokens);
  const stream = raw.stream === true;
  const opts = raw.stream_options;
  const includeUsage = stream && !!opts && typeof opts === "object" && (opts as { include_usage?: unknown }).include_usage === true;

  const body: Record<string, unknown> = { messages };
  for (const key of PASSTHROUGH) if (raw[key] !== undefined) body[key] = raw[key];
  body.max_tokens = maxTokens;

  return { stream, includeUsage, maxTokens, estimatedInputTokens: estimateInputTokens(body), body };
}

function parseMaxTokens(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_OUTPUT_TOKENS;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw bad("invalid_max_tokens", "max_tokens must be a positive integer.");
  }
  return Math.min(raw, MAX_OUTPUT_TOKENS);
}

/** Upper-bound guess at prompt tokens: everything the model reads (messages, tools, formats) at BYTES_PER_TOKEN. */
export function estimateInputTokens(body: Record<string, unknown>): number {
  const { messages, tools, tool_choice, response_format } = body;
  const bytes = utf8Bytes(JSON.stringify([messages, tools ?? null, tool_choice ?? null, response_format ?? null]));
  const count = Array.isArray(messages) ? messages.length : 0;
  return BASE_TOKENS + count * PER_MESSAGE_TOKENS + Math.ceil(bytes / BYTES_PER_TOKEN);
}

export type Usage = { inputTokens: number; outputTokens: number };

/** Largest token count the usage table (int4) takes. */
const MAX_TOKENS_ROW = 2_000_000_000;

/** OpenAI usage {prompt_tokens, completion_tokens}, or null when missing or malformed. */
export function readUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const { prompt_tokens: p, completion_tokens: c } = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!ok(p) || !ok(c)) return null;
  return { inputTokens: Math.min(p, MAX_TOKENS_ROW), outputTokens: Math.min(c, MAX_TOKENS_ROW) };
}

/** Bytes of generated text in a message or a stream delta: content, reasoning, tool call names and arguments. */
export function generatedBytes(msg: unknown): number {
  if (!msg || typeof msg !== "object") return 0;
  const m = msg as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: unknown };
  let n = 0;
  if (typeof m.content === "string") n += utf8Bytes(m.content);
  // Newer vLLM names it "reasoning"; count one of the two, in case a server sends both.
  const reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : m.reasoning;
  if (typeof reasoning === "string") n += utf8Bytes(reasoning);
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      const fn = (call as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
      if (typeof fn?.name === "string") n += utf8Bytes(fn.name);
      if (typeof fn?.arguments === "string") n += utf8Bytes(fn.arguments);
    }
  }
  return n;
}
