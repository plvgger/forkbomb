import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as verifyRoute } from "../app/api/burns/verify/route";
import { GET as cronRoute } from "../app/api/cron/price/route";
import { GET as ledgerRoute } from "../app/api/ledger/route";
import { GET as priceRoute } from "../app/api/price/route";
import { GET as meRoute } from "../app/api/v1/me/route";
import { POST as createRoute } from "../app/api/workspaces/route";
import { credit } from "../lib/server/credits";
import type { Db } from "../lib/server/db";
import { burnTx, randomSignature } from "./fixtures/transactions";
import { fakeChain, freshDb, MIN, seedSamples, useTokenEnv, type FakeChain } from "./helpers";

const BASE = "https://site.test";
let db: Db;
let chain: FakeChain;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${BASE}${path}`, { headers });

beforeEach(async () => {
  db = await freshDb();
  useTokenEnv({ CRON_SECRET: "cron-test-secret" });
  chain = fakeChain();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("POST /api/workspaces", () => {
  it("creates a workspace, shows the key once, and stores only hashes", async () => {
    const res = await createRoute(post("/api/workspaces", { label: "  my laptop " }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { workspace: { id: string; label: string }; apiKey: string; burnMemo: string };
    expect(body.workspace.label).toBe("my laptop");
    expect(body.apiKey).toMatch(/^forkbomb_sk_[0-9A-Za-z]{32}$/);
    expect(body.burnMemo).toBe(`forkbomb:${body.workspace.id}`);
    const [row] = await db.query<{ key_hash: string; created_ip_hash: string }>("SELECT key_hash, created_ip_hash FROM workspaces");
    expect(row!.key_hash).not.toContain(body.apiKey);
    expect(row!.created_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
  });

  it("validates input and rate limits 5 per hour per IP", async () => {
    expect((await createRoute(post("/api/workspaces", "{nope"))).status).toBe(400);
    expect((await createRoute(post("/api/workspaces", { label: "x".repeat(65) }))).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await createRoute(post("/api/workspaces", {}))).status).toBe(201);
    const limited = await createRoute(post("/api/workspaces", {}));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited", type: "rate_limit_error" } });
    expect((await createRoute(post("/api/workspaces", {}, { "x-forwarded-for": "198.51.100.1" }))).status).toBe(201);
  });
});

describe("GET /api/v1/me", () => {
  it("returns workspace, balance and pricing for a valid key, 401 otherwise", async () => {
    vi.stubEnv("UPSTREAM_MODEL", "Qwen/Qwen3-Coder-30B-A3B-Instruct-private"); // never leaves the server
    const created = (await (await createRoute(post("/api/workspaces", { label: "a" }))).json()) as {
      workspace: { id: string };
      apiKey: string;
    };
    await db.tx((q) => credit(q, created.workspace.id, 2_500_000, "grant", "t"));
    const res = await meRoute(get("/api/v1/me", { authorization: `Bearer ${created.apiKey}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      workspace: { id: created.workspace.id, label: "a" },
      credits: { balanceMicroUsd: 2_500_000, balanceUsd: 2.5 },
      pricing: { inputPerMTokUsd: 0.6, outputPerMTokUsd: 2.4, model: "forkbomb-hosted" },
    });
    const bad = await meRoute(get("/api/v1/me", { authorization: "Bearer forkbomb_sk_00000000000000000000000000000000" }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({
      error: { message: expect.any(String), type: "authentication_error", code: "invalid_api_key" },
    });
  });
});

describe("POST /api/burns/verify + GET /api/ledger", () => {
  it("verifies, credits, replays idempotently and shows up in the ledger", async () => {
    const created = (await (await createRoute(post("/api/workspaces", {}))).json()) as { burnMemo: string };
    const bt = new Date(Math.floor((Date.now() - 30 * MIN) / 1000) * 1000);
    await seedSamples(db, bt, [[-10 * MIN, "0.002"], [-5 * MIN, "0.002"], [0, "0.002"], [5 * MIN, "0.002"]]);
    const sig = randomSignature();
    chain.txs.set(sig, burnTx({ signature: sig, blockTime: bt.getTime() / 1000, burns: [{ amount: "5000000000" }], memo: created.burnMemo }));

    const res = await verifyRoute(post("/api/burns/verify", { signature: sig }));
    expect(res.status).toBe(200);
    const { burn } = (await res.json()) as { burn: Record<string, unknown> };
    expect(burn).toMatchObject({ signature: sig, amountUi: "5000", usdValue: "10", creditMicroUsd: 10_000_000, status: "credited" });

    const again = (await (await verifyRoute(post("/api/burns/verify", { signature: sig }))).json()) as { burn: { status: string } };
    expect(again.burn.status).toBe("already_credited");

    const ledger = await ledgerRoute(get("/api/ledger"));
    expect(ledger.headers.get("cache-control")).toContain("public");
    const page = (await ledger.json()) as { burns: { signature: string }[]; totals: unknown; nextCursor: null };
    expect(page.burns.map((b) => b.signature)).toEqual([sig]);
    expect(page.totals).toEqual({ burnedUi: "5000", burnedUsd: "10", burns: 1, creditedMicroUsd: 10_000_000 });

    expect((await ledgerRoute(get("/api/ledger?cursor=garbage"))).status).toBe(400);
    expect((await ledgerRoute(get("/api/ledger?limit=0"))).status).toBe(400);
  });

  it("answers an empty ledger before launch without touching the database", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    await db.close(); // any query would now throw
    const res = await ledgerRoute(get("/api/ledger"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      burns: [],
      nextCursor: null,
      totals: { burnedUi: "0", burnedUsd: "0", burns: 0, creditedMicroUsd: 0 },
    });
    expect((await ledgerRoute(get("/api/ledger?limit=0"))).status).toBe(400);
    db = await freshDb(); // for afterEach
  });

  it("returns clear JSON errors without internals", async () => {
    const missing = await verifyRoute(post("/api/burns/verify", {}));
    expect(missing.status).toBe(400);
    const unknown = await verifyRoute(post("/api/burns/verify", { signature: randomSignature() }));
    expect(unknown.status).toBe(404);
    const body = (await unknown.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts/);
  });
});

describe("price routes", () => {
  it("cron requires the secret, samples, and /api/price reports it", async () => {
    expect((await cronRoute(get("/api/cron/price"))).status).toBe(401);
    expect((await cronRoute(get("/api/cron/price", { authorization: "Bearer wrong" }))).status).toBe(401);
    chain.jupiter = 0.0042;
    const res = await cronRoute(get("/api/cron/price", { authorization: "Bearer cron-test-secret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sample: { priceUsd: "0.0042", source: "jupiter" }, expiredReservations: 0 });
    const price = (await (await priceRoute(get("/api/price"))).json()) as { latest: { priceUsd: string }; twap: { priceUsd: string } };
    expect(price.latest.priceUsd).toBe("0.0042");
    expect(price.twap.priceUsd).toBe("0.0042");
  });

  it("cron is a no-op for price before launch and refuses when CRON_SECRET is unset", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    const res = await cronRoute(get("/api/cron/price", { authorization: "Bearer cron-test-secret" }));
    expect(await res.json()).toMatchObject({ sample: null, skipped: "TOKEN_MINT not set" });
    vi.stubEnv("CRON_SECRET", "");
    expect((await cronRoute(get("/api/cron/price", { authorization: "Bearer " }))).status).toBe(401);
  });
});
