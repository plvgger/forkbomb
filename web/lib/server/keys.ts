// Workspace API keys: "<slug>_sk_" + 32 base62 chars. Shown once, stored only as HMAC-SHA256(KEY_PEPPER, key).

import { createHmac, timingSafeEqual } from "node:crypto";
import { BRAND, getKeyPepper } from "./config";
import { getDb, iso } from "./db";
import { ApiError, clientIp } from "./http";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** n uniformly random base62 chars from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function randomBase62(n: number): string {
  let out = "";
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < n) out += BASE62[b % 62];
    }
  }
  return out;
}

export const keyPrefix = () => `${BRAND.slug}_sk_`;

export function generateApiKey(): string {
  return keyPrefix() + randomBase62(32);
}

export function generateWorkspaceId(): string {
  return "ws_" + randomBase62(20);
}

export function isWellFormedKey(key: string): boolean {
  return key.length === keyPrefix().length + 32 && key.startsWith(keyPrefix()) && /^[0-9A-Za-z]{32}$/.test(key.slice(-32));
}

/** HMAC-SHA256 hex of a secret under the pepper. Used for API keys and for IPs ("ip:" domain). */
export function hmacHex(value: string, pepper = getKeyPepper()): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export const hashApiKey = (key: string, pepper?: string) => hmacHex(`key:${key}`, pepper);
export const hashIp = (ip: string, pepper?: string) => hmacHex(`ip:${ip}`, pepper);

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export type Workspace = { id: string; label: string; createdAt: string };

/** Looks a key up by its hash. Null when unknown or malformed. */
export async function findWorkspaceByKey(key: string): Promise<Workspace | null> {
  if (!isWellFormedKey(key)) return null;
  const hash = hashApiKey(key);
  const db = await getDb();
  const rows = await db.query<{ id: string; label: string; key_hash: string; created_at: unknown }>(
    "SELECT id, label, key_hash, created_at FROM workspaces WHERE key_hash = $1",
    [hash],
  );
  const row = rows[0];
  if (!row || !hashesEqual(row.key_hash, hash)) return null;
  return { id: row.id, label: row.label, createdAt: iso(row.created_at) };
}

/** Bearer key from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") || "");
  return m ? m[1]! : null;
}

/** Well-formed keys one IP may get wrong per minute (per instance) before it is refused without a lookup. */
export const FAILED_AUTH_PER_MINUTE = 30;
const FAILED_AUTH_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;
/**
 * Counted in memory, per instance: every well-formed key costs a database lookup, and a limit counted in the
 * database would add a write to each request instead of saving one. Only lookups count (a missing or malformed
 * key never reaches the database), so one address flooding random keys stops costing queries.
 */
const failedAuth = new Map<string, { start: number; count: number }>();

/** For tests. */
export const resetFailedAuth = () => failedAuth.clear();

function noteFailedAuth(ip: string, now: number): void {
  const f = failedAuth.get(ip);
  if (f && now - f.start < FAILED_AUTH_WINDOW_MS) {
    f.count++;
    return;
  }
  if (failedAuth.size >= MAX_TRACKED_IPS) {
    for (const [k, v] of failedAuth) if (now - v.start >= FAILED_AUTH_WINDOW_MS) failedAuth.delete(k);
    if (failedAuth.size >= MAX_TRACKED_IPS) failedAuth.clear();
  }
  failedAuth.set(ip, { start: now, count: 1 });
}

/** The workspace for a request's Bearer key. Throws ApiError 401 invalid_api_key, or 429 after too many wrong keys. */
export async function authenticate(req: Request, now: number = Date.now()): Promise<Workspace> {
  const ip = hashIp(clientIp(req));
  const f = failedAuth.get(ip);
  if (f && now - f.start < FAILED_AUTH_WINDOW_MS && f.count >= FAILED_AUTH_PER_MINUTE) {
    const retry = Math.max(1, Math.ceil((f.start + FAILED_AUTH_WINDOW_MS - now) / 1000));
    throw new ApiError(429, "rate_limited", `Too many invalid API keys from this address. Retry in ${retry}s.`, {
      "Retry-After": String(retry),
    });
  }
  const key = bearerToken(req);
  const ws = key ? await findWorkspaceByKey(key) : null;
  if (!ws && key && isWellFormedKey(key)) noteFailedAuth(ip, now);
  if (!ws) {
    throw new ApiError(401, "invalid_api_key", "Missing or invalid API key. Send Authorization: Bearer <key>.", {
      "WWW-Authenticate": "Bearer",
    });
  }
  return ws;
}
