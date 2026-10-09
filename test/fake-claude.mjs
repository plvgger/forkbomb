#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests. Reads the prompt from stdin, picks a
// script by the strategy named in it, performs file writes in cwd and emits
// stream-json like `claude -p --output-format stream-json --verbose`.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// The CLI asks these before a run.
if (process.argv[2] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}

const scripts = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPTS, "utf8"));
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), apiKey: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd() }) + "\n");
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const strategy = /Your strategy \(([^)]+)\)/.exec(prompt)?.[1] ?? "";
const steps = scripts[strategy] ?? scripts["*"] ?? [];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Edit"] });
let n = 0;
for (const s of steps) {
  if (s.sleep) await sleep(s.sleep);
  if (s.hang) {
    // Like a session in the middle of a tool call: a child process, and no end in sight.
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ hang: process.pid, child: child.pid }) + "\n");
    await new Promise(() => {});
  }
  if (s.tool) {
    // A tool call and its result, exactly as given, without doing anything.
    const id = `toolu_${++n}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: s.tool.name, input: s.tool.input }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: s.tool.result ?? "", is_error: !!s.tool.is_error }] } });
  }
  if (s.error) {
    out({ type: "assistant", message: { content: [{ type: "text", text: s.error }] } });
    out({ type: "result", subtype: "success", is_error: true, num_turns: 1, result: s.error, total_cost_usd: 0 });
    process.exit(1);
  }
  if (s.write) {
    const id = `toolu_${++n}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: join(process.cwd(), s.write.path), content: s.write.content } }] } });
    mkdirSync(dirname(join(process.cwd(), s.write.path)), { recursive: true });
    writeFileSync(join(process.cwd(), s.write.path), s.write.content);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  }
  if (s.bash) {
    const id = `toolu_${++n}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: s.bash } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ran", is_error: !!s.fail }] } });
  }
  if (s.text) out({ type: "assistant", message: { content: [{ type: "text", text: s.text }] } });
}
out({ type: "result", subtype: "success", is_error: false, num_turns: steps.length, result: steps.at(-1)?.text ?? "done", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
