/**
 * Each fork gets a different way of attacking the same task. Diversity is the
 * point: N copies with one strategy fail the same way N times.
 */
export interface Strategy {
  name: string;
  brief: string;
}

export const STRATEGIES: Strategy[] = [
  { name: "surgeon", brief: "Make the smallest change that could possibly work. Touch as few lines as you can." },
  { name: "root-cause", brief: "Read every file involved before editing anything. Find the underlying cause, then fix it once, properly." },
  { name: "test-driven", brief: "Run the tests first. Let the failure output drive every step; re-run after each change." },
  { name: "rewriter", brief: "If the code at fault is tangled, rewrite the affected function or module cleanly instead of patching it." },
  { name: "skeptic", brief: "Assume the obvious fix is wrong. Hunt for edge cases the tests imply but don't spell out." },
  { name: "cartographer", brief: "Search the codebase for every caller and related definition first, so your fix doesn't break anything else." },
  { name: "sprinter", brief: "Move fast. Make a quick attempt, run the tests, and iterate on what they tell you." },
  { name: "spec-first", brief: "Before coding, write down (to yourself) the exact behaviour each test expects. Then implement to that spec." },
  { name: "bisector", brief: "Isolate one failing test at a time. Fix it completely before moving to the next." },
  { name: "minimalist", brief: "Prefer deleting or simplifying code over adding more. The best fix often removes a special case." },
  { name: "tracer", brief: "Add temporary prints or a scratch script to observe what the code actually does, then fix and clean up." },
  { name: "contrarian", brief: "Pick an approach different from the first one that comes to mind, and see it through." },
];

export function strategyFor(index: number): Strategy {
  return STRATEGIES[index % STRATEGIES.length]!;
}
