import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  costMicroUsd,
  credit,
  expireStaleReservations,
  formatMicroUsd,
  getBalance,
  InsufficientCreditsError,
  reserve,
  settle,
} from "../lib/server/credits";
import { int, type Db } from "../lib/server/db";
import { MIGRATIONS_DIR, loadMigrations, migrate } from "../lib/server/migrate";
import { freshDb, MIN, newWorkspace } from "./helpers";

let db: Db;
let wsId: string;

async function fund(micro: number) {
  await db.tx((q) => credit(q, wsId, micro, "grant", `test-${Math.random()}`));
}

beforeEach(async () => {
  db = await freshDb();
  wsId = (await newWorkspace()).id;
});

afterEach(() => db.close());

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const names = (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.name);
    expect(names[0]).toBe("0001_credits.sql");
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(names);
  });

  it("forbid a negative balance at the database level", async () => {
    await expect(db.query("UPDATE workspaces SET balance_micro_usd = -1 WHERE id = $1", [wsId])).rejects.toThrow();
  });
});

describe("credit", () => {
  it("adds to the balance and refuses the same (reason, ref) twice", async () => {
    await db.tx((q) => credit(q, wsId, 5_000_000, "burn", "sig-1"));
    expect(await getBalance(wsId)).toBe(5_000_000);
    await expect(db.tx((q) => credit(q, wsId, 5_000_000, "burn", "sig-1"))).rejects.toThrow();
    expect(await getBalance(wsId)).toBe(5_000_000);
  });

  it("rejects non-integer or non-positive amounts", async () => {
    await expect(db.tx((q) => credit(q, wsId, 1.5, "grant", "x"))).rejects.toThrow(RangeError);
    await expect(db.tx((q) => credit(q, wsId, 0, "grant", "y"))).rejects.toThrow(RangeError);
  });
});

describe("reserve / settle", () => {
  it("holds, charges the actual cost and refunds the rest, recording usage once", async () => {
    await fund(1_000_000);
    const r = await reserve(wsId, 300_000);
    expect(r.balanceMicroUsd).toBe(700_000);
    const s = await settle(r.id, 120_000, { model: "m", inputTokens: 1000, outputTokens: 200 });
    expect(s).toMatchObject({ chargedMicroUsd: 120_000, refundedMicroUsd: 180_000, capped: false, balanceMicroUsd: 880_000 });
    expect(await settle(r.id, 120_000, { model: "m", inputTokens: 1000, outputTokens: 200 })).toBeNull();
    expect(await getBalance(wsId)).toBe(880_000);
    const usage = await db.query<{ cost_micro_usd: unknown; status: string }>("SELECT cost_micro_usd, status FROM usage");
    expect(usage.map((u) => [int(u.cost_micro_usd), u.status])).toEqual([[120_000, "ok"]]);
  });

  it("caps a charge at the reservation", async () => {
    await fund(1_000_000);
    const r = await reserve(wsId, 100_000);
    const s = await settle(r.id, 250_000, { model: "m", inputTokens: 1, outputTokens: 1 });
    expect(s).toMatchObject({ chargedMicroUsd: 100_000, refundedMicroUsd: 0, capped: true, balanceMicroUsd: 900_000 });
  });

  it("throws InsufficientCreditsError (402) with the remaining balance", async () => {
    await fund(50_000);
    const err = await reserve(wsId, 50_001).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect((err as InsufficientCreditsError).status).toBe(402);
    expect((err as InsufficientCreditsError).code).toBe("insufficient_credits");
    expect((err as InsufficientCreditsError).balanceMicroUsd).toBe(50_000);
    expect((err as Error).message).toContain("$0.050000");
  });

  it("never overspends under concurrent reserves", async () => {
    await fund(1_000_000);
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => reserve(wsId, 30_000)));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(33); // floor(1_000_000 / 30_000)
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientCreditsError)).toBe(true);
    expect(await getBalance(wsId)).toBe(10_000);

    // Settle them all concurrently, half twice: each settles exactly once.
    const ids = ok.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id);
    const settled = await Promise.all(
      [...ids, ...ids.slice(0, 16)].map((id) => settle(id, 10_000, { model: "m", inputTokens: 10, outputTokens: 10 })),
    );
    expect(settled.filter(Boolean)).toHaveLength(33);
    expect(await getBalance(wsId)).toBe(10_000 + 33 * 20_000);
    const [{ n }] = (await db.query<{ n: unknown }>("SELECT COUNT(*) AS n FROM usage")) as [{ n: unknown }];
    expect(int(n)).toBe(33);
  });

  it("expires stale reservations with a full refund, and a late settle does nothing", async () => {
    await fund(1_000_000);
    const stale = await reserve(wsId, 400_000);
    const fresh = await reserve(wsId, 100_000);
    await db.query("UPDATE reservations SET created_at = now() - interval '20 minutes' WHERE id = $1", [stale.id]);
    expect(await getBalance(wsId)).toBe(500_000);

    expect(await expireStaleReservations(15)).toBe(1);
    expect(await getBalance(wsId)).toBe(900_000);
    expect(await expireStaleReservations(15)).toBe(0);
    expect(await settle(stale.id, 1, { model: "m", inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(await getBalance(wsId)).toBe(900_000);

    const later = new Date(Date.now() + 16 * MIN);
    expect(await expireStaleReservations(15, later)).toBe(1); // now the fresh one is stale too
    expect(await getBalance(wsId)).toBe(1_000_000);
    expect(await settle(fresh.id, 1, { model: "m", inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe("pricing helpers", () => {
  it("rounds cost up to the next micro-USD", () => {
    const pricing = { inputPerMTokMicroUsd: 600_000, outputPerMTokMicroUsd: 2_400_000 };
    expect(costMicroUsd(1_000_000, 0, pricing)).toBe(600_000);
    expect(costMicroUsd(1, 0, pricing)).toBe(1); // 0.6 micro -> 1
    expect(costMicroUsd(1000, 500, pricing)).toBe(1_800); // 600 + 1200
    expect(costMicroUsd(0, 0, pricing)).toBe(0);
  });

  it("formats micro-USD exactly", () => {
    expect(formatMicroUsd(0)).toBe("0.000000");
    expect(formatMicroUsd(1_234_567)).toBe("1.234567");
  });
});
