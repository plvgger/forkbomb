// `npm run db:migrate`: apply pending migrations to DATABASE_URL (Neon).
// Without DATABASE_URL it dry-runs every migration against a throwaway in-memory PGlite.

import { openNeon, openPglite } from "./db";
import { migrate } from "./migrate";

async function main() {
  const url = process.env.DATABASE_URL;
  const db = url ? await openNeon(url) : await openPglite();
  try {
    const applied = await migrate(db);
    const target = url ? "DATABASE_URL" : "in-memory PGlite (dry run, DATABASE_URL unset)";
    console.log(applied.length ? `applied ${applied.join(", ")} to ${target}` : `up to date: ${target}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
