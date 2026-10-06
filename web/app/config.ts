// One place for links, copy and numbers that change at launch.
// Every number here is real. Do not add numbers that are not in this file.

// LAUNCH GATE: the repo must be public at this URL before the site is shared.
// Override per deploy with NEXT_PUBLIC_GITHUB_URL. `npm run check:links` fails until it returns 200.
export const GITHUB_URL = (process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/plvgger/forkbomb").replace(/\/$/, "");
export const ADVISORY_URL = `${GITHUB_URL}/security/advisories/new`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
export const CONTRACT_ADDRESS = ""; // set at coin launch; empty renders the "launching" state
export const REPLAY_URL = "/replay"; // full replay UI. next.config.mjs rewrites it to the static file; use a plain <a>
export const REPLAY_EMBED_URL = "/replay/index.html?embed=1"; // chromeless tree, scales to fit its frame

export const SITE = {
  name: "Forkbomb",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://forkbomb-heads.vercel.app",
  title: "Forkbomb — Fork your coding agent. Let your tests pick the winner.",
  description:
    "Forkbomb forks a coding agent into sandboxed copies of your repo in milliseconds, gives each a different strategy, and keeps the one whose patch passes your test suite. Open source, MIT, macOS.",
  license: "MIT",
  platform: "macOS only today (APFS + Seatbelt)",
} as const;

/**
 * One install step. `lines` is what the code block shows: "$ " marks a prompt,
 * lines ending in a backslash continue the command on the next line. Copy strips the prompts.
 */
export type InstallStep = { label: string; lines: string[] };

// Forkbomb is not on npm yet. Install from source only.
export const INSTALL: InstallStep[] = [
  { label: "Clone and build", lines: [`$ git clone ${GITHUB_URL}`, "$ cd forkbomb && npm install && npm run build"] },
  { label: "Check the machine", lines: ["$ node dist/cli.js doctor"] },
  {
    label: "Run it",
    lines: ["$ node dist/cli.js run ./my-repo \\", '    --task "fix the failing tests" \\', '    --test "npm test" --ui'],
  },
];

/** All install steps as one shell block, each step introduced by a comment. */
export const INSTALL_SCRIPT = INSTALL.map((st) => [`# ${st.label}`, ...st.lines].join("\n")).join("\n\n");

export const REQUIREMENTS = [
  "macOS on an APFS volume",
  "Node 22 or newer",
  "Xcode Command Line Tools",
  "Claude Code logged in (Pro or Max plan), or an Anthropic API key",
] as const;

// forkbomb bench. MacBook Air M2 24 GB, 80 MB node_modules tree, 4,400 files, 16 heads.
export const BENCH = {
  machine: "MacBook Air (M2, 24 GB)",
  workload: "80 MB node_modules tree, 4,400 files",
  heads: 16,
  clonefile: { perHeadMs: 45, extraDisk: "22 MB", extraDiskMB: 22 },
  copy: { perHeadMs: 1108, extraDisk: "1.3 GB", extraDiskMB: 1300 },
  speedup: "≈24×",
  diskSaving: "≈60×",
} as const;

// A real recorded run. Same events power /replay.
export const RUN = {
  date: "2026-10-05",
  id: "20261005-155223",
  engine: "Claude Code on a Max plan",
  repo: "demo calc repo",
  testCmd: "node --test",
  baseline: { passing: 4, failing: 10, total: 14 },
  heads: [
    { id: "1.01", strategy: "surgeon" },
    { id: "1.02", strategy: "root-cause" },
    { id: "1.03", strategy: "test-driven" },
    { id: "1.04", strategy: "rewriter" },
  ],
  forkMsEach: 1.13,
  winner: { id: "1.04", strategy: "rewriter", passed: 14, total: 14 },
  severed: 3,
  patch: { lines: 94, files: 1 },
  durationS: 38.7,
} as const;

export const TEST_COUNT = 61; // automated tests in Forkbomb's own suite

// Real terminal transcript of RUN (trimmed). Tones map to <Terminal> line tones.
export const RUN_TRANSCRIPT: { text: string; tone?: "cmd" | "out" | "dim" | "ok" | "err" | "warn" | "info" }[] = [
  { tone: "cmd", text: 'forkbomb run ./calc --task "fix the failing tests" --test "node --test" --heads 4' },
  { tone: "dim", text: "run · 4 heads × 2 rounds · claude-code · race · sandbox on" },
  { tone: "warn", text: "baseline: 4 passing, 10 failing" },
  { tone: "ok", text: "fork  4 heads in 1.13 ms each via apfs-clonefile" },
  { tone: "out", text: "  1.01 surgeon   1.02 root-cause   1.03 test-driven   1.04 rewriter" },
  { tone: "dim", text: "  1.04 ✎ create calc.js  ·  $ node --test" },
  { tone: "ok", text: "  1.04 PASS 14/14 · 94 lines" },
  { tone: "err", text: "  1.01 severed   1.02 severed   1.03 severed  (1.04 passed first)" },
  { tone: "ok", text: "SURVIVOR 1.04: 94 lines in 1 file. All 14 tests pass. 38.7s" },
];

export type NavLink = { label: string; href: string; external?: boolean; native?: boolean };

export const NAV: NavLink[] = [
  { label: "Product", href: "/" },
  { label: "Docs", href: "/docs" },
  { label: "Security", href: "/security" },
  { label: "Replay", href: REPLAY_URL, native: true },
];

export const TOKEN_LINK: NavLink = { label: "$FORKBOMB", href: "/token" };

export const FOOTER: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: "/" },
      { label: "Watch a run", href: REPLAY_URL, native: true },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Install", href: "/docs#install" },
      { label: "Source code", href: GITHUB_URL, external: true },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "Issues", href: ISSUES_URL, external: true },
      { label: "$FORKBOMB", href: "/token" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
      { label: "MIT License", href: `${GITHUB_URL}/blob/main/LICENSE`, external: true },
    ],
  },
];
