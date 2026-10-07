// Fixed-window rate limits counted in the database (one upsert per hit), so they hold across serverless instances.
// IP subjects are always hashed with hashIp() before they get here.

import { getConfig } from "./config";
import { getDb, int } from "./db";
import { ApiError } from "./http";

export type Bucket = "workspace_create" | "verify" | "gateway" | "rpc" | "admin";

const BUCKETS: Record<Bucket, { windowMs: number; limit: () => number }> = {
  workspace_create: { windowMs: 60 * 60_000, limit: () => getConfig().limits.workspaceCreatePerHour },
  verify: { windowMs: 60_000, limit: () => getConfig().limits.verifyPerMinute },
  gateway: { windowMs: 60_000, limit: () => getConfig().limits.gatewayPerMinute },
  rpc: { windowMs: 60_000, limit: () => getConfig().limits.rpcPerMinute },
  admin: { windowMs: 60_000, limit: () => 10 },
};

export type RateLimitResult = { ok: boolean; limit: number; remaining: number; resetAt: Date; count: number };

/** Count one hit for subject in bucket's current window. */
export async function hit(bucket: Bucket, subject: string, now: Date = new Date()): Promise<RateLimitResult> {
  const { windowMs, limit: limitOf } = BUCKETS[bucket];
  const limit = limitOf();
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const db = await getDb();
  const rows = await db.query<{ count: unknown }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [`${bucket}:${subject}`, new Date(start).toISOString()],
  );
  const count = int(rows[0]!.count);
  return { ok: count <= limit, limit, remaining: Math.max(0, limit - count), resetAt: new Date(start + windowMs), count };
}

/** Count a hit and throw ApiError 429 rate_limited (with Retry-After) when over the limit. */
export async function enforce(bucket: Bucket, subject: string, now: Date = new Date()): Promise<RateLimitResult> {
  const r = await hit(bucket, subject, now);
  if (!r.ok) {
    const retryAfter = Math.max(1, Math.ceil((r.resetAt.getTime() - now.getTime()) / 1000));
    throw new ApiError(429, "rate_limited", `Rate limit reached (${r.limit} per window). Retry in ${retryAfter}s.`, {
      "Retry-After": String(retryAfter),
    });
  }
  return r;
}

/** Delete windows that ended more than a day ago. Run from the cron. */
export async function pruneRateLimits(now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM rate_limits WHERE window_start < $1", [new Date(now.getTime() - 26 * 3600_000).toISOString()]);
}
