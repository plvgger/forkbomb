import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyPepper, usdToMicro } from "../lib/server/config";
import type { Db } from "../lib/server/db";
import { ApiError } from "../lib/server/http";
import {
  authenticate,
  findWorkspaceByKey,
  generateApiKey,
  hashApiKey,
  hashesEqual,
  hashIp,
  isWellFormedKey,
  randomBase62,
} from "../lib/server/keys";
import { enforce, hit, pruneRateLimits } from "../lib/server/ratelimit";
import { freshDb, newWorkspace } from "./helpers";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe("API keys", () => {
  it("look like <slug>_sk_ + 32 base62 chars and are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, generateApiKey));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k).toMatch(/^forkbomb_sk_[0-9A-Za-z]{32}$/);
      expect(isWellFormedKey(k)).toBe(true);
    }
    expect(isWellFormedKey("forkbomb_sk_short")).toBe(false);
    expect(randomBase62(1000)).toMatch(/^[0-9A-Za-z]{1000}$/);
  });

  it("hash round trip: the stored hash finds the workspace, nothing else does", async () => {
    const ws = await newWorkspace("round trip");
    const [row] = await db.query<{ key_hash: string }>("SELECT key_hash FROM workspaces WHERE id = $1", [ws.id]);
    expect(row!.key_hash).toBe(hashApiKey(ws.apiKey));
    expect(row!.key_hash).not.toContain(ws.apiKey.slice(9));
    expect(await findWorkspaceByKey(ws.apiKey)).toMatchObject({ id: ws.id, label: "round trip" });
    expect(await findWorkspaceByKey(generateApiKey())).toBeNull();
    expect(await findWorkspaceByKey(ws.apiKey.slice(0, -1) + (ws.apiKey.endsWith("a") ? "b" : "a"))).toBeNull();
  });

  it("depends on the pepper", () => {
    const k = generateApiKey();
    expect(hashApiKey(k, "a")).not.toBe(hashApiKey(k, "b"));
    expect(hashIp("1.2.3.4", "a")).not.toBe(hashApiKey("1.2.3.4", "a"));
    expect(hashesEqual(hashApiKey(k, "a"), hashApiKey(k, "a"))).toBe(true);
    expect(hashesEqual(hashApiKey(k, "a"), hashApiKey(k, "b"))).toBe(false);
    expect(hashesEqual("", "")).toBe(false);
  });

  it("authenticate reads the Bearer header and throws 401 invalid_api_key", async () => {
    const ws = await newWorkspace();
    const ok = await authenticate(new Request("https://x.test/api/v1/me", { headers: { authorization: `Bearer ${ws.apiKey}` } }));
    expect(ok.id).toBe(ws.id);
    for (const authorization of [undefined, "Bearer", `Basic ${ws.apiKey}`, `Bearer ${generateApiKey()}`]) {
      const req = new Request("https://x.test/api/v1/me", { headers: authorization ? { authorization } : {} });
      const err = await authenticate(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).code).toBe("invalid_api_key");
    }
  });

  it("requires KEY_PEPPER in production", () => {
    vi.stubEnv("KEY_PEPPER", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getKeyPepper()).toThrow(/KEY_PEPPER/);
    vi.stubEnv("NODE_ENV", "test");
    expect(getKeyPepper()).toMatch(/dev-only/);
  });
});

describe("rate limits", () => {
  it("count per fixed window and reset in the next one", async () => {
    const t0 = new Date("2026-10-06T12:00:10Z");
    for (let i = 1; i <= 5; i++) expect((await hit("workspace_create", "ip-a", t0)).ok).toBe(true);
    const sixth = await hit("workspace_create", "ip-a", new Date("2026-10-06T12:59:59Z"));
    expect(sixth).toMatchObject({ ok: false, limit: 5, remaining: 0 });
    expect(sixth.resetAt.toISOString()).toBe("2026-10-06T13:00:00.000Z");
    expect((await hit("workspace_create", "ip-b", t0)).ok).toBe(true); // other subjects are separate
    expect((await hit("workspace_create", "ip-a", new Date("2026-10-06T13:00:00Z"))).ok).toBe(true);
  });

  it("use per-minute windows for verify and gateway, with configurable limits", async () => {
    vi.stubEnv("RATE_GATEWAY_PER_MINUTE", "3");
    const t = new Date("2026-10-06T12:00:30Z");
    for (let i = 0; i < 3; i++) await enforce("gateway", "ws_1", t);
    const err = await enforce("gateway", "ws_1", t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).code).toBe("rate_limited");
    expect((err as ApiError).headers["Retry-After"]).toBe("30");
    expect((await hit("gateway", "ws_1", new Date("2026-10-06T12:01:00Z"))).ok).toBe(true);
    for (let i = 0; i < 30; i++) expect((await hit("verify", "ip", t)).ok).toBe(true);
    expect((await hit("verify", "ip", t)).ok).toBe(false);
  });

  it("prune old windows", async () => {
    await hit("verify", "ip", new Date("2026-10-01T00:00:00Z"));
    await hit("verify", "ip", new Date("2026-10-06T12:00:00Z"));
    await pruneRateLimits(new Date("2026-10-06T12:00:00Z"));
    expect(await db.query("SELECT * FROM rate_limits")).toHaveLength(1);
  });
});

describe("config", () => {
  it("parses USD to micro-USD exactly and falls back on junk", () => {
    expect(usdToMicro("0.60", 1)).toBe(600_000);
    expect(usdToMicro("2.4", 1)).toBe(2_400_000);
    expect(usdToMicro("5000", 1)).toBe(5_000_000_000);
    expect(usdToMicro("-1", 7)).toBe(7);
    expect(usdToMicro("1e3", 7)).toBe(7);
    expect(usdToMicro(undefined, 7)).toBe(7);
  });
});
