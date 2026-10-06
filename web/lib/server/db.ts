// A tiny typed query interface over Postgres. Same SQL everywhere:
// production uses Neon (DATABASE_URL), dev and tests use an in-memory PGlite with migrations applied.

import { getConfig, isProduction } from "./config";
import { migrate } from "./migrate";

export type Row = Record<string, unknown>;

/** Anything that runs parameterized SQL ($1, $2, ...). */
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Run fn in one transaction. Use only the handle passed to fn inside it. Commits on return, rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const GLOBAL_KEY = Symbol.for("credits.db");
type Holder = { [GLOBAL_KEY]?: Promise<Db> };

/** The process-wide database. Survives dev hot reloads. */
export function getDb(): Promise<Db> {
  const g = globalThis as Holder;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = openDefault().catch((err) => {
      delete g[GLOBAL_KEY];
      throw err;
    });
  }
  return g[GLOBAL_KEY];
}

/** Replace the process-wide database (tests). Pass null to reset. */
export function setDb(db: Db | null): void {
  const g = globalThis as Holder;
  if (db) g[GLOBAL_KEY] = Promise.resolve(db);
  else delete g[GLOBAL_KEY];
}

async function openDefault(): Promise<Db> {
  const url = getConfig().databaseUrl;
  if (url) return openNeon(url);
  if (isProduction()) throw new Error("DATABASE_URL is required in production");
  const db = await openPglite();
  await migrate(db);
  return db;
}

/** Neon: HTTP for single queries, a short-lived WebSocket pool for interactive transactions. */
export async function openNeon(url: string): Promise<Db> {
  const { neon, neonConfig, Pool } = await import("@neondatabase/serverless");
  if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket === "function") {
    neonConfig.webSocketConstructor = globalThis.WebSocket;
  }
  const sql = neon(url);
  return {
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
    async exec(text: string) {
      await withPool(Pool, url, (c) => c.query(text));
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      return withPool(Pool, url, async (client) => {
        await client.query("BEGIN");
        try {
          const out = await fn({
            async query<R extends Row>(text: string, params: unknown[] = []) {
              return (await client.query(text, params)).rows as R[];
            },
            async exec(text: string) {
              await client.query(text);
            },
          });
          await client.query("COMMIT");
          return out;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    },
    async close() {},
  };
}

type NeonPool = typeof import("@neondatabase/serverless").Pool;
type NeonClient = import("@neondatabase/serverless").PoolClient;

async function withPool<T>(Pool: NeonPool, url: string, fn: (c: NeonClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/** In-memory PGlite. Queries and transactions are serialized by PGlite itself. */
export async function openPglite(dataDir?: string): Promise<Db> {
  // Kept out of the server bundle: production never loads it.
  const { PGlite } = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ "@electric-sql/pglite"
  )) as typeof import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  const wrap = (h: { query: typeof pg.query; exec: typeof pg.exec }): Queryable => ({
    async query<T extends Row>(text: string, params: unknown[] = []) {
      return (await h.query<T>(text, params)).rows;
    },
    async exec(text: string) {
      await h.exec(text);
    },
  });
  return {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

// Drivers disagree on types: Neon returns int8 as string and timestamptz as Date, PGlite returns numbers.

/** An integer column (int, bigint) as a safe JS integer. */
export function int(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n)) throw new Error(`not a safe integer: ${String(v)}`);
  return n;
}

/** A timestamptz column as an ISO string. */
export function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return d.toISOString();
}

/** A numeric column (always selected as text or returned as string) as a decimal string. */
export function dec(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Postgres error code, e.g. "23505" for unique_violation. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : undefined;
}
