// Applies db/migrations/*.sql in name order, each once, recorded in schema_migrations.
// Safe to run concurrently: an advisory lock serializes runners and each file applies in its own transaction.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db";

export const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const LOCK_ID = 7_264_311; // arbitrary, fixed

export type Migration = { name: string; sql: string };

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), "utf8") })));
}

/** Returns the names applied by this call (empty when already up to date). */
export async function migrate(db: Db, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied: string[] = [];
  for (const m of all) {
    const did = await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
      const seen = await q.query("SELECT 1 FROM schema_migrations WHERE name = $1", [m.name]);
      if (seen.length) return false;
      await q.exec(m.sql);
      await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
      return true;
    });
    if (did) applied.push(m.name);
  }
  return applied;
}
