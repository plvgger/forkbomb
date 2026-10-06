// One place for the links and copy that change at launch.
export const GITHUB_URL = "https://github.com/plvgger/hydra"; // TODO: confirm repo slug before public launch
export const CONTRACT_ADDRESS = ""; // set at coin launch; empty renders the "launching" state
export const REPLAY_URL = "/replay/index.html?embed=0";

export const STATS = [
  { v: "1.1 ms", k: "to fork a head (this run)" },
  { v: "4 → 1", k: "heads raced, one survived" },
  { v: "10 → 0", k: "failing tests, fixed in 39s" },
  { v: "22 MB", k: "disk for 16 heads, not 1.3 GB" },
];

export const TERMINAL: [string, string][] = [
  ["d", '$ hydra run ./calc --task "fix the failing tests" --test "node --test" --heads 4'],
  ["", "  run · 4 heads × 2 rounds · claude-code · race · sandbox on"],
  ["y", "  baseline: 4 passing, 10 failing"],
  ["g", "  fork  4 heads in 1.13 ms each · 0 B extra disk"],
  ["", "  1.01 surgeon   1.02 root-cause   1.03 test-driven   1.04 rewriter"],
  ["d", "  1.04 ✎ rewrote calc.js  ·  $ node --test"],
  ["g", "  1.04 PASS 14/14"],
  ["r", "  1.01 severed   1.02 severed   1.03 severed  (1.04 passed first)"],
  ["g", "  SURVIVOR 1.04 · 94 lines in 1 file · 38.7s"],
];
