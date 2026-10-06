// Docs data. Every flag, default, message and list here is taken from the
// Hydra source (src/cli.ts, src/judge.ts, src/strategies.ts,
// src/engines/canary.ts, src/orchestrator.ts). Keep it in sync with the CLI.

export type TocItem = { id: string; label: string };

export const TOC: TocItem[] = [
  { id: "overview", label: "Overview" },
  { id: "requirements", label: "Requirements" },
  { id: "install", label: "Install" },
  { id: "quickstart", label: "Quickstart" },
  { id: "how-it-works", label: "How a run works" },
  { id: "engines", label: "Engines" },
  { id: "isolation", label: "Isolation" },
  { id: "commands", label: "Commands" },
  { id: "artifacts", label: "Run artifacts" },
  { id: "task-and-test", label: "Writing --task and --test" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "faq", label: "FAQ" },
];

export type Flag = { flag: string; def: string; desc: string };

export const RUN_FLAGS: Flag[] = [
  { flag: '--task "…"', def: "required", desc: "What the heads should do. Every head gets the same task and a different strategy." },
  { flag: '--test "cmd"', def: "required", desc: "The command that decides who wins. Runs in a fresh clone under Hydra's Seatbelt profile." },
  { flag: "--heads N", def: "8", desc: "Heads per round. 1 to 64." },
  { flag: "--rounds N", def: "2", desc: "Rounds. Each round forks from the best head so far. 1 to 10." },
  { flag: "--mode race|best", def: "race", desc: "race: the first full pass wins and the rest are cut. best: every head finishes and the smallest passing diff wins." },
  { flag: "--engine NAME", def: "claude-code", desc: "claude-code runs heads through Claude Code on your Claude plan. api calls the Anthropic API with a key." },
  { flag: "--model ID", def: "engine default", desc: "Model for the heads. api: claude-opus-5-5. claude-code: your Claude Code default (for example opus or sonnet)." },
  { flag: "--effort LEVEL", def: "medium", desc: "low, medium, high, xhigh or max." },
  { flag: "--max-turns N", def: "30", desc: "Tool-use turns per head. 1 to 500." },
  { flag: "--head-timeout S", def: "600", desc: "Seconds per head." },
  { flag: "--bash-timeout S", def: "120", desc: "Seconds per shell command." },
  { flag: "--test-timeout S", def: "300", desc: "Seconds per test run." },
  { flag: "--concurrency N", def: "8", desc: "Max heads talking to the model at once. 1 to 64." },
  { flag: "--protect GLOB", def: "none", desc: "Extra read-only path for heads. Repeatable." },
  { flag: "--no-default-protect", def: "off", desc: "Don't protect test files and test config by default." },
  { flag: "--apply", def: "off", desc: "Apply the winning patch to your repo." },
  { flag: "--keep-heads", def: "off", desc: "Keep losing heads' clones on disk." },
  { flag: "--network", def: "off", desc: "Let heads reach the network. Default is loopback only. API engine only." },
  { flag: "--no-sandbox", def: "off", desc: "Run heads without the macOS sandbox. Not recommended." },
  { flag: "--ui", def: "off", desc: "Open the live tree view in your browser." },
  { flag: "--port N", def: "4317", desc: "Port for --ui and replay." },
  { flag: "--no-open", def: "off", desc: "Don't open a browser for --ui." },
  { flag: "--runs-dir DIR", def: "~/.hydra/runs", desc: "Where runs live. Can't be inside the repo." },
  { flag: "--claude-bin PATH", def: "claude", desc: "Claude Code binary to drive. claude-code engine only." },
  { flag: "-v, --verbose", def: "off", desc: "Print every tool call." },
];

export const BENCH_FLAGS: Flag[] = [
  { flag: "[dir]", def: ".", desc: "Workspace to fork." },
  { flag: "--heads N", def: "16", desc: "How many forks to make with each method." },
  { flag: "--no-copy", def: "off", desc: "Skip the plain-copy baseline." },
  { flag: "--json", def: "off", desc: "Print rows as JSON instead of a table." },
];

export const REPLAY_FLAGS: Flag[] = [
  { flag: "<run-dir | events.jsonl>", def: "required", desc: "A run folder or its event log." },
  { flag: "--port N", def: "4317", desc: "Port for the local viewer (bound to 127.0.0.1)." },
  { flag: "--no-open", def: "off", desc: "Don't open a browser." },
];

export const CANARY_FLAGS: Flag[] = [
  { flag: "--claude-bin PATH", def: "claude", desc: "Claude Code binary to test." },
  { flag: "--model ID", def: "Claude Code default", desc: "Model for the canary session." },
];

export const STRATEGIES: { name: string; brief: string }[] = [
  { name: "surgeon", brief: "Make the smallest change that could possibly work." },
  { name: "root-cause", brief: "Read every file involved first. Find the underlying cause, fix it once." },
  { name: "test-driven", brief: "Run the tests first. Let failure output drive every step." },
  { name: "rewriter", brief: "If the code at fault is tangled, rewrite the function or module cleanly." },
  { name: "skeptic", brief: "Assume the obvious fix is wrong. Hunt for edge cases the tests imply." },
  { name: "cartographer", brief: "Find every caller and related definition before changing anything." },
  { name: "sprinter", brief: "Make a quick attempt, run the tests, iterate." },
  { name: "spec-first", brief: "Write down what each test expects, then implement to that spec." },
  { name: "bisector", brief: "Isolate one failing test at a time. Finish it before the next." },
  { name: "minimalist", brief: "Prefer deleting or simplifying code over adding more." },
  { name: "tracer", brief: "Observe what the code actually does with prints or a scratch script." },
  { name: "contrarian", brief: "Pick an approach different from the first that comes to mind." },
];

export const DOCTOR_CHECKS: { check: string; verifies: string; fix: string; cmd?: boolean }[] = [
  { check: "macOS", verifies: "The platform. Seatbelt and clonefile are macOS features.", fix: "Run on a Mac." },
  { check: "Node", verifies: "Node major version is 22 or newer.", fix: "Install Node 22+." },
  { check: "APFS copy-on-write clones", verifies: "~/.hydra sits on an APFS volume that supports clonefile.", fix: "Move ~/.hydra to APFS. Otherwise Hydra falls back to plain copies." },
  { check: "clang", verifies: "A compiler for the one-file clone helper, built on first run.", fix: "xcode-select --install", cmd: true },
  { check: "Seatbelt sandbox confines writes", verifies: "A sandboxed shell can write inside its folder and not outside it.", fix: "Open an issue with the doctor output." },
  { check: "Claude Code logged in", verifies: "claude auth status reports a login. Needed for the default engine.", fix: "claude auth login", cmd: true },
  { check: "Anthropic API key", verifies: "ANTHROPIC_API_KEY is set. Optional, only for --engine api.", fix: "Export it or add it to ~/.hydra/.env" },
  { check: "Isolation canary", verifies: "Whether the canary has passed for this Claude Code version.", fix: "hydra canary", cmd: true },
];

export const CANARY_CHECKS: { name: string; probe: string }[] = [
  { name: "Writes inside the clone work", probe: "Creates inside.txt in the head's clone." },
  { name: "Shell can't write outside the clone", probe: "Tries ../escape-bash.txt from Bash." },
  { name: "File tools can't write outside the clone", probe: "Tries to write escape-write.txt next to the clone." },
  { name: "No outbound network", probe: "Runs curl against example.com." },
  { name: "Denied folders are unreadable", probe: "Plants a secret in a denied folder and checks it never surfaces, through the shell or the Read tool." },
  { name: ".git is read-only", probe: "Tries to create .git/hydra-probe." },
];

export const EVENTS: { type: string; meaning: string }[] = [
  { type: "run_start", meaning: "Heads, rounds, model, effort, mode, engine, sandbox state." },
  { type: "baseline", meaning: "The suite on the untouched body: passing, failing, exit code." },
  { type: "fork", meaning: "Heads forked, per-head fork time, forker used, logical and physical bytes." },
  { type: "head_start", meaning: "A head starts with its parent and strategy." },
  { type: "tool", meaning: "One bash or edit call, with a summary, result and duration." },
  { type: "note", meaning: "A short progress note from a head." },
  { type: "head_done", meaning: "A head stopped: reason, turns, cost when known." },
  { type: "judging", meaning: "The judge picked up a head's patch." },
  { type: "judge", meaning: "Verdict: score, pass and fail counts, diff size, reverted test edits." },
  { type: "sever", meaning: "A head was cut, and why." },
  { type: "round_end", meaning: "Best head of the round and its score." },
  { type: "winner", meaning: "The survivor, its patch and summary." },
  { type: "run_end", meaning: "Outcome, duration, patch path, whether it was applied." },
  { type: "log", meaning: "Info, warnings and errors." },
];

export const TEST_FORMATS = [
  "node:test",
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "unittest",
  "cargo test",
  "go test",
];

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
