// Docs data. Every flag, default, message and list here is taken from the
// CLI source (src/cli.ts, src/judge.ts, src/strategies.ts, src/engines/*.ts,
// src/orchestrator.ts) and the hosted API (app/api/**, lib/server/**).
// Keep it in sync with both.

import { CLI_HOME, CLI_PROBE, SITE, TOKEN_MEMO_PREFIX } from "../../config";

/** Binary name these docs write. Until the npm release, run `node dist/cli.js` in its place. */
export const BIN = "forkbomb";
/** Where the CLI keeps runs, the canary cache and .env. Set by the CLI, not by the brand. */
export const HOME = CLI_HOME;
/** Hosted engine env vars and key format (BRAND slug "forkbomb"). */
export const KEY_ENV = "FORKBOMB_API_KEY";
export const URL_ENV = "FORKBOMB_HOSTED_URL";
export const KEY_PREFIX = "forkbomb_sk_";
export const HOSTED_MODEL = "forkbomb-hosted";
export const API_BASE = `${SITE.url}/api/v1`;
export const MEMO = `${TOKEN_MEMO_PREFIX}<workspaceId>`;

export type TocItem = { id: string; label: string };

export const TOC: TocItem[] = [
  { id: "overview", label: "Overview" },
  { id: "requirements", label: "Requirements" },
  { id: "install", label: "Install" },
  { id: "quickstart", label: "Quickstart" },
  { id: "how-it-works", label: "How a race works" },
  { id: "engines", label: "Engines" },
  { id: "hosted", label: "Hosted engine" },
  { id: "isolation", label: "Isolation" },
  { id: "commands", label: "Commands" },
  { id: "artifacts", label: "Run artifacts" },
  { id: "task-and-test", label: "Writing --task and --test" },
  { id: "burn", label: "Burn for compute" },
  { id: "api", label: "API reference" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "faq", label: "FAQ" },
];

export type Flag = { flag: string; def: string; desc: string };

export const RUN_FLAGS: Flag[] = [
  {
    flag: '--task "…"',
    def: "required",
    desc: "What the forks should do. Every fork gets the same task and a different strategy.",
  },
  {
    flag: '--test "cmd"',
    def: "required",
    desc: "The command that decides who wins. Runs in a fresh clone under Forkbomb's Seatbelt profile.",
  },
  {
    flag: "--forks N",
    def: "8",
    desc: "Forks per round. 1 to 64. The pre-rename --heads, --head-timeout and --keep-heads names still work.",
  },
  {
    flag: "--rounds N",
    def: "2",
    desc: "Rounds. Each round forks again from the best fork so far. 1 to 10.",
  },
  {
    flag: "--mode race|best",
    def: "race",
    desc: "race: the first full pass exits 0 and the rest are killed. best: every fork finishes and the smallest passing diff wins.",
  },
  {
    flag: "--engine NAME",
    def: "claude-code",
    desc: "claude-code runs forks through Claude Code on your Claude plan. api calls the Anthropic API with a key. hosted uses Forkbomb's GPU model, paid with credit.",
  },
  {
    flag: "--model ID",
    def: "engine default",
    desc: "Model for the forks. api: claude-opus-5-5. claude-code: your Claude Code default (for example opus or sonnet). Ignored by hosted.",
  },
  {
    flag: "--effort LEVEL",
    def: "medium",
    desc: "low, medium, high, xhigh or max.",
  },
  {
    flag: "--max-turns N",
    def: "30",
    desc: "Tool-use turns per fork. 1 to 500.",
  },
  { flag: "--fork-timeout S", def: "600", desc: "Seconds per fork." },
  { flag: "--bash-timeout S", def: "120", desc: "Seconds per shell command." },
  { flag: "--test-timeout S", def: "300", desc: "Seconds per test run." },
  {
    flag: "--concurrency N",
    def: "8",
    desc: "Max forks talking to the model at once. 1 to 64.",
  },
  {
    flag: "--protect GLOB",
    def: "none",
    desc: "Extra read-only path for forks. Repeatable.",
  },
  {
    flag: "--no-default-protect",
    def: "off",
    desc: "Don't protect test files and test config by default.",
  },
  {
    flag: "--apply",
    def: "off",
    desc: "Apply the winning patch to your repo.",
  },
  {
    flag: "--keep-forks",
    def: "off",
    desc: "Keep killed forks' clones on disk.",
  },
  {
    flag: "--network",
    def: "off",
    desc: "Let forks reach the network. Default is loopback only. Not on the claude-code engine.",
  },
  {
    flag: "--no-sandbox",
    def: "off",
    desc: "Run forks without the macOS sandbox. Not recommended.",
  },
  {
    flag: "--ui",
    def: "off",
    desc: "Open the live tree view in your browser.",
  },
  { flag: "--port N", def: "4317", desc: "Port for --ui and replay." },
  { flag: "--no-open", def: "off", desc: "Don't open a browser for --ui." },
  {
    flag: "--runs-dir DIR",
    def: `${HOME}/runs`,
    desc: "Where runs live. Can't be inside the repo.",
  },
  {
    flag: "--claude-bin PATH",
    def: "claude",
    desc: "Claude Code binary to drive. claude-code engine only.",
  },
  { flag: "-v, --verbose", def: "off", desc: "Print every tool call." },
];

export const BENCH_FLAGS: Flag[] = [
  { flag: "[dir]", def: ".", desc: "Workspace to fork." },
  {
    flag: "--forks N",
    def: "16",
    desc: "How many forks to make with each method.",
  },
  { flag: "--no-copy", def: "off", desc: "Skip the plain-copy baseline." },
  {
    flag: "--json",
    def: "off",
    desc: "Print rows as JSON instead of a table.",
  },
];

export const REPLAY_FLAGS: Flag[] = [
  {
    flag: "<run-dir | events.jsonl>",
    def: "required",
    desc: "A run folder or its event log.",
  },
  {
    flag: "--port N",
    def: "4317",
    desc: "Port for the local viewer (bound to 127.0.0.1).",
  },
  { flag: "--no-open", def: "off", desc: "Don't open a browser." },
];

export const CANARY_FLAGS: Flag[] = [
  {
    flag: "--claude-bin PATH",
    def: "claude",
    desc: "Claude Code binary to test.",
  },
  {
    flag: "--model ID",
    def: "Claude Code default",
    desc: "Model for the canary session.",
  },
];

export const STRATEGIES: { name: string; brief: string }[] = [
  {
    name: "surgeon",
    brief: "Make the smallest change that could possibly work.",
  },
  {
    name: "root-cause",
    brief: "Read every file involved first. Find the underlying cause, fix it once.",
  },
  {
    name: "test-driven",
    brief: "Run the tests first. Let failure output drive every step.",
  },
  {
    name: "rewriter",
    brief: "If the code at fault is tangled, rewrite the function or module cleanly.",
  },
  {
    name: "skeptic",
    brief: "Assume the obvious fix is wrong. Hunt for edge cases the tests imply.",
  },
  {
    name: "cartographer",
    brief: "Find every caller and related definition before changing anything.",
  },
  { name: "sprinter", brief: "Make a quick attempt, run the tests, iterate." },
  {
    name: "spec-first",
    brief: "Write down what each test expects, then implement to that spec.",
  },
  {
    name: "bisector",
    brief: "Isolate one failing test at a time. Finish it before the next.",
  },
  {
    name: "minimalist",
    brief: "Prefer deleting or simplifying code over adding more.",
  },
  {
    name: "tracer",
    brief: "Observe what the code actually does with prints or a scratch script.",
  },
  {
    name: "contrarian",
    brief: "Pick an approach different from the first that comes to mind.",
  },
];

export const DOCTOR_CHECKS: {
  check: string;
  verifies: string;
  fix: string;
  cmd?: boolean;
}[] = [
  {
    check: "macOS",
    verifies: "The platform. Seatbelt and clonefile are macOS features.",
    fix: "Run on a Mac.",
  },
  {
    check: "Node",
    verifies: "Node major version is 22 or newer.",
    fix: "Install Node 22+.",
  },
  {
    check: "APFS copy-on-write clones",
    verifies: `${HOME} sits on an APFS volume that supports clonefile.`,
    fix: `Move ${HOME} to APFS. Otherwise forks fall back to plain copies.`,
  },
  {
    check: "clang",
    verifies: "A compiler for the one-file clone helper, built on first run.",
    fix: "xcode-select --install",
    cmd: true,
  },
  {
    check: "Seatbelt sandbox confines writes",
    verifies: "A sandboxed shell can write inside its folder and not outside it.",
    fix: "Open an issue with the doctor output.",
  },
  {
    check: "Claude Code logged in",
    verifies: "claude auth status reports a login. Needed for the default engine.",
    fix: "claude auth login",
    cmd: true,
  },
  {
    check: "Anthropic API key",
    verifies: "ANTHROPIC_API_KEY is set. Optional, only for --engine api.",
    fix: `Export it or add it to ${HOME}/.env`,
  },
  {
    check: "Hosted key and credit",
    verifies: "Optional, only for --engine hosted. If FORKBOMB_API_KEY is set, asks the gateway for your balance.",
    fix: "Create a workspace at /app (opens at launch)",
  },
  {
    check: "Isolation canary",
    verifies: "Whether the canary has passed for this Claude Code version.",
    fix: "forkbomb canary",
    cmd: true,
  },
];

export const CANARY_CHECKS: { name: string; probe: string }[] = [
  {
    name: "Writes inside the clone work",
    probe: "Creates inside.txt in the fork's clone.",
  },
  {
    name: "Shell can't write outside the clone",
    probe: "Tries ../escape-bash.txt from Bash.",
  },
  {
    name: "File tools can't write outside the clone",
    probe: "Tries to write escape-write.txt next to the clone.",
  },
  { name: "No outbound network", probe: "Runs curl against example.com." },
  {
    name: "Denied folders are unreadable",
    probe: "Plants a secret in a denied folder and checks it never surfaces, through the shell or the Read tool.",
  },
  { name: ".git is read-only", probe: `Tries to create ${CLI_PROBE}.` },
];

export const EVENTS: { type: string; meaning: string }[] = [
  {
    type: "run_start",
    meaning: "Forks, rounds, model, effort, mode, engine, sandbox state.",
  },
  {
    type: "baseline",
    meaning: "The suite on untouched pid 1: passing, failing, exit code.",
  },
  {
    type: "fork",
    meaning: "Forks made, per-fork clone time, forker used, logical and physical bytes.",
  },
  {
    type: "head_start",
    meaning: "A fork starts with its parent and strategy.",
  },
  {
    type: "tool",
    meaning: "One bash or edit call, with a summary, result and duration.",
  },
  { type: "note", meaning: "A short progress note from a fork." },
  {
    type: "head_done",
    meaning: "A fork stopped: reason, turns, cost when known.",
  },
  { type: "judging", meaning: "The judge picked up a fork's patch." },
  {
    type: "judge",
    meaning: "Verdict: score, pass and fail counts, diff size, reverted test edits.",
  },
  { type: "sever", meaning: "A fork was killed, and why." },
  { type: "round_end", meaning: "Best fork of the round and its score." },
  { type: "winner", meaning: "The fork that exited 0, its patch and summary." },
  {
    type: "run_end",
    meaning: "Outcome, duration, patch path, whether it was applied.",
  },
  { type: "log", meaning: "Info, warnings and errors." },
];

export const TEST_FORMATS = ["node:test", "vitest", "jest", "mocha", "pytest", "unittest", "cargo test", "go test"];

export const DEFAULT_PROTECT = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "**/conftest.py",
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/.mocharc*",
  "**/pytest.ini",
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/tox.ini",
  "**/Cargo.toml",
  "**/go.mod",
  "**/Makefile",
];

export const CREDITS_FLAGS: Flag[] = [
  {
    flag: "--json",
    def: "off",
    desc: "Print the raw /api/v1/me response instead of the summary.",
  },
];

/** Errors from POST /api/burns/verify, from lib/server/burns.ts. */
export const VERIFY_ERRORS: {
  code: string;
  status: number;
  meaning: string;
}[] = [
  {
    code: "invalid_signature",
    status: 400,
    meaning: "Not a base58 Solana transaction signature.",
  },
  {
    code: "not_configured",
    status: 503,
    meaning: "The token has not launched yet. Burns open at launch.",
  },
  {
    code: "not_found",
    status: 404,
    meaning: "No transaction with this signature on Solana mainnet.",
  },
  {
    code: "not_finalized",
    status: 409,
    meaning: "Seen, but not finalized yet. Retry in about 30 seconds.",
  },
  {
    code: "failed_tx",
    status: 422,
    meaning: "The transaction failed on chain. Nothing was burned.",
  },
  {
    code: "no_burn",
    status: 422,
    meaning: "The transaction burns no token, or zero tokens.",
  },
  { code: "wrong_mint", status: 422, meaning: "It burns a different token." },
  {
    code: "balance_mismatch",
    status: 422,
    meaning: "The burn amount doesn't match the token account's balance change.",
  },
  {
    code: "bad_memo",
    status: 422,
    meaning: "No memo, more than one forkbomb: memo, or extra text in it.",
  },
  {
    code: "unknown_workspace",
    status: 422,
    meaning: "The memo names a workspace that doesn't exist.",
  },
  {
    code: "too_old_for_price",
    status: 422,
    meaning: "No price sample in the 30 minutes before the burn, or too few around it, to price it.",
  },
  {
    code: "price_unavailable",
    status: 503,
    meaning: "No price right now. Retry in a few minutes.",
  },
  {
    code: "rpc_error",
    status: 502,
    meaning: "The Solana RPC didn't answer. Retry shortly.",
  },
  {
    code: "rate_limited",
    status: 429,
    meaning: "Too many verify calls from one address. Wait for Retry-After.",
  },
];

/** Errors from POST /api/v1/chat/completions, from lib/server/gateway/chat.ts. */
export const GATEWAY_ERRORS: {
  code: string;
  status: number;
  meaning: string;
}[] = [
  {
    code: "invalid_api_key",
    status: 401,
    meaning: "Missing or unknown key. Send Authorization: Bearer <key>.",
  },
  {
    code: "insufficient_credits",
    status: 402,
    meaning: "The request could cost more than the balance. Nothing is charged.",
  },
  {
    code: "rate_limited",
    status: 429,
    meaning: "Per-workspace request limit. Wait for Retry-After.",
  },
  {
    code: "upstream_unavailable",
    status: 503,
    meaning:
      "The GPU pool isn't provisioned (no Retry-After: don't retry) or is warming up (Retry-After set). Nothing is charged.",
  },
  {
    code: "upstream_busy",
    status: 503,
    meaning: "The pool is at capacity. Retry after Retry-After. Nothing is charged.",
  },
  {
    code: "upstream_error",
    status: 502,
    meaning: "The model failed or cut off. Nothing is charged.",
  },
  {
    code: "invalid_*",
    status: 400,
    meaning: "Bad body: messages, tools, max_tokens, stream or JSON.",
  },
];
