// Where the API key lives in the browser. Default: this tab only (sessionStorage), gone when the tab closes.
// "Remember on this device" also writes localStorage. Storage can be blocked, so every access is guarded.

const KEY = "forkbomb.apiKey";
const PENDING = "forkbomb.pendingBurns";

function store(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(kind: "local" | "session", k: string): string | null {
  try {
    return store(kind)?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

function write(kind: "local" | "session", k: string, v: string | null): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (v === null) s.removeItem(k);
    else s.setItem(k, v);
  } catch {}
}

/** The saved key and whether it came from this device's long-term storage. */
export function loadKey(): { key: string; remembered: boolean } | null {
  const session = read("session", KEY);
  if (session) return { key: session, remembered: read("local", KEY) === session };
  const local = read("local", KEY);
  return local ? { key: local, remembered: true } : null;
}

export function saveKey(key: string, remember: boolean): void {
  write("session", KEY, key);
  write("local", KEY, remember ? key : null);
}

export function forgetKey(): void {
  write("session", KEY, null);
  write("local", KEY, null);
}

export type PendingBurn = { signature: string; workspaceId: string; at: number };

/** Burns sent but not yet credited, so a reload can resume verifying them. Public data only (signatures). */
export function loadPending(workspaceId: string): PendingBurn[] {
  try {
    const all = JSON.parse(read("local", PENDING) || "[]") as unknown;
    if (!Array.isArray(all)) return [];
    return all.filter(
      (p): p is PendingBurn =>
        !!p && typeof p.signature === "string" && p.workspaceId === workspaceId && typeof p.at === "number",
    );
  } catch {
    return [];
  }
}

export function savePending(p: PendingBurn): void {
  const rest = allPending().filter((x) => x.signature !== p.signature);
  write("local", PENDING, JSON.stringify([...rest, p].slice(-20)));
}

export function dropPending(signature: string): void {
  write("local", PENDING, JSON.stringify(allPending().filter((x) => x.signature !== signature)));
}

function allPending(): PendingBurn[] {
  try {
    const all = JSON.parse(read("local", PENDING) || "[]") as unknown;
    return Array.isArray(all) ? (all as PendingBurn[]) : [];
  } catch {
    return [];
  }
}
