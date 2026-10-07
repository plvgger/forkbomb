// One place for links, copy and numbers that change at launch.
// Every number here is real. Do not add numbers that are not in this file.

// LAUNCH GATE: the repo must be public at this URL before the site is shared.
// Override per deploy with NEXT_PUBLIC_GITHUB_URL. `npm run check:links` fails until it returns 200.
export const GITHUB_URL = (process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/plvgger/forkbomb").replace(/\/$/, "");
export const REPO_DIR = GITHUB_URL.split("/").pop() || "forkbomb"; // folder `git clone` creates
export const ADVISORY_URL = `${GITHUB_URL}/security/advisories/new`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
/**
 * Where the CLI keeps runs, the canary cache and .env, and the file its .git canary probes.
 * Set by the CLI (src/util.ts resolveHome, src/engines/canary.ts), not by the brand.
 */
export const CLI_HOME = "~/.forkbomb";
export const CLI_PROBE = ".git/forkbomb-probe";
export const CONTRACT_ADDRESS = ""; // set at coin launch; empty renders the "launching" state
export const TOKEN_MEMO_PREFIX = "forkbomb:"; // burn memo is `forkbomb:<workspaceId>`; must equal `${BRAND.slug}:` (lib/server/config.ts, pinned by a test)
export const APP_URL = "/app"; // "Connect wallet" and "Open app" both go here
export const REPLAY_URL = "/replay"; // full replay UI. next.config.mjs rewrites it to the static file; use a plain <a>
export const REPLAY_EMBED_URL = "/replay/index.html?embed=1"; // chromeless tree, scales to fit its frame

export const SITE = {
  name: "Forkbomb",
  wordmark: "forkbomb",
  ticker: "$FORKBOMB",
  glyph: ":(){ :|:& };:",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://forkbomb.fun",
  title: "Forkbomb — Fork your coding agent. Kill the losers. Keep the patch that passes.",
  description:
    "Forkbomb forks a coding agent into sandboxed copies of your repo in milliseconds. Each fork tries a different strategy, your test suite judges them, the losers get killed and the passing patch is yours. Open source, MIT, macOS.",
  tagline: "Fork it. Test it. Kill the rest.",
  license: "MIT",
  platform: "macOS only today (APFS + Seatbelt)",
} as const;

/** Honest launch status. Flip these only when they are true. */
export const STATUS = {
  tokenLive: CONTRACT_ADDRESS.trim().length > 0,
  hostedPoolLive: true, // the GPU pool serves the gateway (RunPod). Credit to spend on it opens with the token.
  appLive: true, // /app is live (wallet connect, keys, credit). Burning stays closed until tokenLive.
} as const;

/**
 * One install step. `lines` is what the code block shows: "$ " marks a prompt,
 * lines ending in a backslash continue the command on the next line. Copy strips the prompts.
 */
export type InstallStep = { label: string; lines: string[] };

// Forkbomb is not on npm yet. Install from source only.
export const INSTALL: InstallStep[] = [
  {
    label: "Clone and build",
    lines: [`$ git clone ${GITHUB_URL}`, `$ cd ${REPO_DIR} && npm install && npm run build`],
  },
  { label: "Check the machine", lines: ["$ node dist/cli.js doctor"] },
  {
    label: "Run it",
    lines: [
      "$ node dist/cli.js run ./my-repo \\",
      '    --task "fix the failing tests" \\',
      '    --test "npm test" --ui',
    ],
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

/** Engines the CLI can drive. `hosted` is paid with credit from burning $FORKBOMB: usable once the pool is up and burns are open. */
export const ENGINES = [
  {
    id: "claude-code",
    name: "Claude Code",
    pays: "Your Claude Pro or Max plan",
    live: true,
  },
  {
    id: "api",
    name: "Anthropic API",
    pays: "Your Anthropic API key",
    live: true,
  },
  {
    id: "hosted",
    name: "Forkbomb hosted",
    pays: "Credit from burning $FORKBOMB",
    live: STATUS.hostedPoolLive && STATUS.tokenLive,
  },
] as const;

// Bench. MacBook Air M2 24 GB, 80 MB node_modules tree, 4,400 files, 16 forks.
export const BENCH = {
  machine: "MacBook Air (M2, 24 GB)",
  workload: "80 MB node_modules tree, 4,400 files",
  forks: 16,
  clonefile: { perForkMs: 45, extraDisk: "22 MB", extraDiskMB: 22 },
  copy: { perForkMs: 1108, extraDisk: "1.3 GB", extraDiskMB: 1300 },
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
  forks: [
    { id: "1.01", strategy: "surgeon" },
    { id: "1.02", strategy: "root-cause" },
    { id: "1.03", strategy: "test-driven" },
    { id: "1.04", strategy: "rewriter" },
  ],
  forkMsEach: 1.13,
  winner: { id: "1.04", strategy: "rewriter", passed: 14, total: 14 },
  killed: 3,
  patch: { lines: 94, files: 1 },
  durationS: 38.7,
} as const;

/**
 * Per-fork detail from the same run's event log (public/replay/events.jsonl).
 * forkMs: clonefile time per fork. turns: agent turns. tools: tool calls. End state at 38.5 s.
 */
export const RUN_PS: {
  id: string;
  strategy: string;
  forkMs: number;
  turns: number;
  tools: number;
  result: "exit0" | "killed";
}[] = [
  {
    id: "1.01",
    strategy: "surgeon",
    forkMs: 0.97,
    turns: 8,
    tools: 5,
    result: "killed",
  },
  {
    id: "1.02",
    strategy: "root-cause",
    forkMs: 1.46,
    turns: 8,
    tools: 5,
    result: "killed",
  },
  {
    id: "1.03",
    strategy: "test-driven",
    forkMs: 1.05,
    turns: 6,
    tools: 3,
    result: "killed",
  },
  {
    id: "1.04",
    strategy: "rewriter",
    forkMs: 1.03,
    turns: 9,
    tools: 5,
    result: "exit0",
  },
];
export const RUN_END_S = 38.5; // when the judge passed 1.04 and killed the rest

export const TEST_COUNT = 94; // tests in the CLI suite (`npx vitest list` at the repo root); test/site.test.ts checks it

// Real terminal transcript of RUN (trimmed). Tones map to <Terminal> line tones.
export const RUN_TRANSCRIPT: {
  text: string;
  tone?: "cmd" | "out" | "dim" | "ok" | "err" | "warn" | "info" | "signal";
}[] = [
  {
    tone: "cmd",
    text: 'node dist/cli.js run ./calc --task "fix the failing tests" --test "node --test" --forks 4',
  },
  {
    tone: "dim",
    text: "run · 4 forks × 2 rounds · claude-code · race · sandbox on",
  },
  { tone: "warn", text: "baseline: 4 passing, 10 failing" },
  {
    tone: "signal",
    text: "fork()  4 copies of pid 1 in 1.13 ms each via apfs-clonefile",
  },
  {
    tone: "out",
    text: "  1.01 surgeon   1.02 root-cause   1.03 test-driven   1.04 rewriter",
  },
  { tone: "dim", text: "  1.04 ✎ create calc.js  ·  $ node --test" },
  { tone: "ok", text: "  1.04 PASS 14/14 · 94 lines" },
  { tone: "signal", text: "  kill -9  1.01  1.02  1.03  (1.04 passed first)" },
  {
    tone: "ok",
    text: "exit 0  1.04: 94 lines in 1 file. All 14 tests pass. 38.7s",
  },
];

export type NavLink = {
  label: string;
  href: string;
  external?: boolean;
  native?: boolean;
};

export const NAV: NavLink[] = [
  { label: "Product", href: "/" },
  { label: "Docs", href: "/docs" },
  { label: "Burns", href: "/burns" },
  { label: "Security", href: "/security" },
];

export const TOKEN_LINK: NavLink = { label: "$FORKBOMB", href: "/token" };

/** Nav calls to action. Both open /app (live; burns inside it stay closed until the token launches). */
export const NAV_CTA = {
  wallet: { label: "Connect wallet", href: APP_URL },
  app: { label: "Open app", href: APP_URL },
} as const;

export const FOOTER: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: "/" },
      { label: "Watch a run", href: REPLAY_URL, native: true },
      { label: "Security", href: "/security" },
      { label: "Open app", href: APP_URL },
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
    title: "Token",
    links: [
      { label: "$FORKBOMB", href: "/token" },
      { label: "Burn ledger", href: "/burns" },
      { label: "Issues", href: ISSUES_URL, external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
      {
        label: "MIT License",
        href: `${GITHUB_URL}/blob/main/LICENSE`,
        external: true,
      },
    ],
  },
];
