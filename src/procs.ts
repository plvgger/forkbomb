/**
 * Registry of live child process groups (sandboxed commands, test runs,
 * Claude Code forks), so an interrupted run never leaves them running.
 */
const groups = new Set<number>();

/** Track a detached child's process group. Returns an untrack function. */
export function track(pid: number | undefined): () => void {
  if (!pid) return () => {};
  groups.add(pid);
  return () => groups.delete(pid);
}

/** Stop tracking a process group (it exited on its own). */
export function untrack(pid: number | undefined): void {
  if (pid) groups.delete(pid);
}

/** Kill one process group and stop tracking it. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
  groups.delete(pid);
}

/**
 * Signal every tracked process group. Safe to call more than once. After SIGKILL nothing is left to track;
 * after a gentler signal the groups stay tracked, so a SIGKILL can still follow for any that ignore it.
 */
export function killAll(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {
      groups.delete(pid); // already gone
    }
  }
  if (signal === "SIGKILL") groups.clear();
}

export function liveGroups(): number {
  return groups.size;
}
