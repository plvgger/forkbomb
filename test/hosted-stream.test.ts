import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatAssembler, SseParser, type SseItem } from "../src/engines/hosted-stream.js";

/**
 * A real stream from the hosted pool (2026-10-07), trimmed to four reasoning tokens, with the model renamed
 * the way the gateway renames it: a short thought, then two bash calls in parallel, finish, usage, [DONE].
 */
const CAPTURED = readFileSync(join(process.cwd(), "test", "fixtures", "hosted-stream.sse"), "utf8");
/** What the gateway adds around the upstream events: keep-alives, and its settlement just before [DONE]. */
const GATEWAY = `: keep-alive\n\n${CAPTURED.replace("data: [DONE]", ": x-request-cost-usd=0.000427 x-credits-remaining-usd=4.999573\n\ndata: [DONE]")}`;

/** Feeds `text` in pieces of `size` characters, then ends the stream, and assembles whatever came out. */
function assemble(text: string, size = text.length) {
  const sse = new SseParser();
  const chat = new ChatAssembler();
  const items: SseItem[] = [];
  for (let i = 0; i < text.length; i += size) items.push(...sse.push(text.slice(i, i + size)));
  items.push(...sse.end());
  const errors = [];
  for (const item of items) {
    if ("comment" in item) chat.comment(item.comment);
    else {
      const err = chat.event(item.data);
      if (err) errors.push(err);
    }
  }
  return { chat, items, errors };
}

describe("SseParser", () => {
  it("splits events and comments at any chunk boundary, with \\n, \\r\\n or \\r line endings", () => {
    const text = ': keep-alive\n\ndata: {"a":1}\n\ndata: line one\ndata: line two\n\nevent: x\nid: 7\ndata:no-space\n\n: x-request-cost-usd=0.1\n\ndata: [DONE]\n\n';
    const want = [{ comment: "keep-alive" }, { data: '{"a":1}' }, { data: "line one\nline two" }, { data: "no-space" }, { comment: "x-request-cost-usd=0.1" }, { data: "[DONE]" }];
    for (const eol of ["\n", "\r\n", "\r"]) {
      const t = text.replaceAll("\n", eol);
      for (const size of [1, 2, 3, 5, 8, 13, t.length]) expect(assemble(t, size).items, `eol ${JSON.stringify(eol)}, size ${size}`).toEqual(want);
    }
  });

  it("holds a trailing \\r until it knows whether \\n follows", () => {
    const sse = new SseParser();
    expect(sse.push('data: {"a":1}\r')).toEqual([]);
    expect(sse.push("\n\r")).toEqual([]);
    expect(sse.push("\n")).toEqual([{ data: '{"a":1}' }]);
  });

  it("counts a last event that is missing its blank line once the stream ends", () => {
    const sse = new SseParser();
    expect(sse.push('data: {"a":1}\n\ndata: [DONE]')).toEqual([{ data: '{"a":1}' }]);
    expect(sse.end()).toEqual([{ data: "[DONE]" }]);
    expect(sse.end()).toEqual([]);
  });
});

describe("ChatAssembler", () => {
  it("rebuilds a real streamed turn: two parallel tool calls, usage, the gateway's cost, reasoning kept out of content", () => {
    for (const size of [1, 7, 64, 1000, GATEWAY.length]) {
      const { chat, errors } = assemble(GATEWAY, size);
      expect(errors).toEqual([]);
      expect(chat.done).toBe(true);
      expect(chat.costUsd).toBe(0.000427);
      expect(chat.remainingUsd).toBe(4.999573);
      expect(chat.completion()).toEqual({
        id: "chatcmpl-bad76a8c80b45906",
        model: "forkbomb-hosted",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "chatcmpl-tool-a99acce0555a0d38", type: "function", function: { name: "bash", arguments: '{"command": "ls"}' } },
                { id: "chatcmpl-tool-bd29e58f334275a6", type: "function", function: { name: "bash", arguments: '{"command": "cat package.json"}' } },
              ],
              reasoning_content: "The user is asking",
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 340, total_tokens: 432, completion_tokens: 92, completion_tokens_details: { reasoning_tokens: 36 } },
      });
    }
  });

  it("concatenates content, interleaves tool calls by index, and takes one reasoning field, never both", () => {
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const { chat } = assemble(
      [
        chunk({ role: "assistant", content: "" }),
        chunk({ reasoning: "think", reasoning_content: "think" }),
        chunk({ content: "Fixing " }),
        chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "bash", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "edit" } }] }),
        chunk({ content: "both." }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"command":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"view"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '"true"}' } }] }),
        chunk({}, "tool_calls"),
      ].join(""),
    );
    expect(chat.done).toBe(false);
    expect(chat.finished).toBe(true);
    const m = chat.completion().choices[0]!.message;
    expect(m.content).toBe("Fixing both.");
    expect(m.reasoning_content).toBe("think");
    expect(m.tool_calls).toEqual([
      { id: "a", type: "function", function: { name: "edit", arguments: '{"command":"view"}' } },
      { id: "b", type: "function", function: { name: "bash", arguments: '{"command":"true"}' } },
    ]);
  });

  it("places calls without an index by their position, and leaves a missing id out so the engine can name it", () => {
    const calls = [{ function: { name: "bash", arguments: "{}" } }, { id: "c2", function: { name: "edit", arguments: "{}" } }];
    const { chat } = assemble(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: "tool_calls" }] })}\n\n`);
    expect(chat.completion().choices[0]!.message.tool_calls).toEqual([
      { type: "function", function: { name: "bash", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "edit", arguments: "{}" } },
    ]);
  });

  it("returns error events, skips data that is not a JSON object, and reads only the settlement from comments", () => {
    const { chat, errors } = assemble(
      [
        "data: not json\n\n",
        "data: [1,2]\n\n",
        ": keep-alive\n\n",
        ": x-request-cost-usd=nope x-credits-remaining-usd=2.5\n\n",
        'data: {"error":{"message":"The hosted model failed mid-stream.","type":"server_error","code":"upstream_error"}}\n\n',
        'data: {"error":{"message":"no code"}}\n\n',
      ].join(""),
    );
    expect(errors).toEqual([
      { message: "The hosted model failed mid-stream.", type: "server_error", code: "upstream_error" },
      { message: "no code", type: "", code: "" },
    ]);
    expect(chat.costUsd).toBeNull();
    expect(chat.remainingUsd).toBe(2.5);
    expect(chat.finished).toBe(false);
    expect(chat.started).toBe(false);
    expect(chat.completion()).toEqual({ choices: [] });
  });

  it("tells an answer that has started from one the model has produced something in", () => {
    const delta = (d: object) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`;
    const role = delta({ role: "assistant", content: "" });
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 } })}\n\n`;
    expect(assemble(usage).chat).toMatchObject({ started: false, generated: false });
    expect(assemble(role).chat).toMatchObject({ started: true, generated: false });
    for (const d of [{ content: "a" }, { reasoning: "b" }, { tool_calls: [{ index: 0, id: "c", function: { name: "bash" } }] }]) {
      expect(assemble(role + delta(d)).chat, JSON.stringify(d)).toMatchObject({ started: true, generated: true, finished: false });
    }
  });
});
