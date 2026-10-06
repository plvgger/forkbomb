/**
 * Every process group Forkbomb starts for a head, so Ctrl-C or a crash can take
 * them all down instead of leaving them running after Forkbomb exits.
 */
const live = new Set<number>();

export function track(pid: number | undefined): void {
  if (pid) live.add(pid);
}

export function untrack(pid: number | undefined): void {
  if (pid) live.delete(pid);
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export function killAll(): void {
  for (const pid of live) killGroup(pid);
  live.clear();
}

let installed = false;
/** Install once: on Ctrl-C, SIGTERM or exit, kill every tracked process group. */
export function installExitHandlers(onSignal?: () => void): void {
  if (installed) return;
  installed = true;
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      onSignal?.();
      killAll();
      process.exit(130);
    });
  }
}
