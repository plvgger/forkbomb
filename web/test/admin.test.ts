import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as grantRoute } from "../app/api/admin/grant/route";
import { getBalance } from "../lib/server/credits";
import type { Db } from "../lib/server/db";
import { freshDb, newWorkspace } from "./helpers";

const SECRET = "a".repeat(40);
const BASE = "http://localhost:4319";
let db: Db;

const grant = (body: unknown, auth = `Bearer ${SECRET}`, ip = "203.0.113.9") =>
  grantRoute(
    new Request(`${BASE}/api/admin/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("ADMIN_SECRET", SECRET);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe("POST /api/admin/grant", () => {
  it("does not exist while ADMIN_SECRET is unset or short", async () => {
    vi.stubEnv("ADMIN_SECRET", "");
    expect((await grant({}, "Bearer ")).status).toBe(404);
    vi.stubEnv("ADMIN_SECRET", "short-secret");
    expect((await grant({}, "Bearer short-secret")).status).toBe(404);
  });

  it("rejects a missing or wrong secret", async () => {
    const ws = await newWorkspace();
    expect((await grant({ workspaceId: ws.id, usd: "1", ref: "t1" }, "")).status).toBe(401);
    expect((await grant({ workspaceId: ws.id, usd: "1", ref: "t1" }, `Bearer ${"b".repeat(40)}`)).status).toBe(401);
    expect(await getBalance(ws.id)).toBe(0);
  });

  it("grants credit once per ref and records it in the ledger", async () => {
    const ws = await newWorkspace();
    const res = await grant({ workspaceId: ws.id, usd: "2.50", ref: "smoke-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ws.id, grantedUsd: "2.500000", balanceUsd: "2.500000", ref: "smoke-1" });
    expect(await getBalance(ws.id)).toBe(2_500_000);

    expect((await grant({ workspaceId: ws.id, usd: "2.50", ref: "smoke-1" })).status).toBe(409);
    expect(await getBalance(ws.id)).toBe(2_500_000);

    const rows = await db.query<{ reason: string; ref: string }>("SELECT reason, ref FROM credit_ledger WHERE workspace_id = $1", [ws.id]);
    expect(rows).toEqual([{ reason: "grant", ref: "admin:smoke-1" }]);
  });

  it("validates the body and caps one grant", async () => {
    const ws = await newWorkspace();
    for (const body of [
      { usd: "1", ref: "x" },
      { workspaceId: ws.id, usd: 1, ref: "x" },
      { workspaceId: ws.id, usd: "1e3", ref: "x" },
      { workspaceId: ws.id, usd: "-1", ref: "x" },
      { workspaceId: ws.id, usd: "0", ref: "x" },
      { workspaceId: ws.id, usd: "1", ref: "" },
      { workspaceId: ws.id, usd: "1", ref: "has space" },
    ]) {
      expect((await grant(body)).status, JSON.stringify(body)).toBe(400);
    }
    const big = await grant({ workspaceId: ws.id, usd: "100.000001", ref: "big" });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("grant_too_large");
    vi.stubEnv("MAX_GRANT_USD", "500");
    expect((await grant({ workspaceId: ws.id, usd: "500", ref: "big" })).status).toBe(200);
    expect(await getBalance(ws.id)).toBe(500_000_000);
  });

  it("404s an unknown workspace without crediting anything", async () => {
    const res = await grant({ workspaceId: "ws_doesnotexist000000", usd: "1", ref: "ghost" });
    expect(res.status).toBe(404);
    expect(await db.query("SELECT 1 FROM credit_ledger")).toEqual([]);
  });

  it("rate limits guesses per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await grant({}, `Bearer ${"c".repeat(40)}`, "198.51.100.4")).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
