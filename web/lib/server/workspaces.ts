// Workspaces: the unit that holds credit and API keys. Anonymous: a label and a key, nothing else.

import { BRAND } from "./config";
import { getDb, iso, pgCode } from "./db";
import { ApiError } from "./http";
import { generateApiKey, generateWorkspaceId, hashApiKey, type Workspace } from "./keys";

export const LABEL_MAX = 64;

/** Trimmed label, or throws 400. Printable characters only. */
export function parseLabel(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ApiError(400, "invalid_label", "label must be a string.");
  const label = raw.trim();
  if (label.length > LABEL_MAX) throw new ApiError(400, "invalid_label", `label is at most ${LABEL_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new ApiError(400, "invalid_label", "label has control characters.");
  return label;
}

/** The memo a burn must carry to credit this workspace. */
export const burnMemo = (workspaceId: string) => `${BRAND.slug}:${workspaceId}`;

/** Creates a workspace and returns its API key. The key is never retrievable again. */
export async function createWorkspace(opts: { label?: string; ipHash?: string } = {}): Promise<{
  workspace: Workspace;
  apiKey: string;
}> {
  const db = await getDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = generateWorkspaceId();
    const apiKey = generateApiKey();
    try {
      const rows = await db.query<{ created_at: unknown }>(
        "INSERT INTO workspaces (id, label, key_hash, created_ip_hash) VALUES ($1, $2, $3, $4) RETURNING created_at",
        [id, opts.label ?? "", hashApiKey(apiKey), opts.ipHash ?? null],
      );
      return { workspace: { id, label: opts.label ?? "", createdAt: iso(rows[0]!.created_at) }, apiKey };
    } catch (err) {
      if (pgCode(err) !== "23505") throw err; // astronomically unlikely id/key collision: retry
    }
  }
  throw new Error("could not allocate a workspace id");
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const db = await getDb();
  const rows = await db.query<{ id: string; label: string; created_at: unknown }>(
    "SELECT id, label, created_at FROM workspaces WHERE id = $1",
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, label: r.label, createdAt: iso(r.created_at) } : null;
}
