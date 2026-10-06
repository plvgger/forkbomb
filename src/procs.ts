/**
 * Registry of live child process groups (sandboxed commands, test runs,
 * Claude Code heads), so an interrupted Hydra never leaves them running.
 */
const groups = new Set<number>();

/** Track a detached child's process group. Returns an untrack function. */
export function track(pid: number | undefined): () => void {
  if (!pid) return () => {};
  groups.add(pid);
  return () => groups.delete(pid);
}

/** Kill every tracked process group. Safe to call more than once. */
export function killAll(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  }
  groups.clear();
}

export function liveGroups(): number {
  return groups.size;
}
