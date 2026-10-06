import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BurnError, listLedger, valueBurn, verifyBurn } from "../lib/server/burns";
import { getBalance } from "../lib/server/credits";
import { parseDecimal, PRICE_SCALE } from "../lib/server/decimal";
import type { Db } from "../lib/server/db";
import { ATA, ATA_2, burnTx, MINT, OTHER_MINT, randomSignature, type TxSpec } from "./fixtures/transactions";
import { fakeChain, freshDb, MIN, newWorkspace, seedSamples, useTokenEnv, type FakeChain } from "./helpers";

const NOW = new Date("2026-10-06T12:00:00Z");
const BLOCK_TIME = new Date(NOW.getTime() - 20 * MIN); // old enough that live quotes are never used
const ONE_MILLION = "1000000000000"; // 1,000,000 tokens at 6 decimals

let db: Db;
let chain: FakeChain;
let ws: Awaited<ReturnType<typeof newWorkspace>>;

/** Steady $0.001 every 5 minutes from 20 min before the burn to 10 min after. */
async function steadyPrice(price = "0.001") {
  await seedSamples(db, BLOCK_TIME, [-20, -15, -10, -5, 0, 5, 10].map((m) => [m * MIN, price] as [number, string]));
}

function put(spec: Omit<TxSpec, "signature" | "blockTime"> & { blockTime?: number }) {
  const signature = randomSignature();
  chain.txs.set(signature, burnTx({ blockTime: Math.floor(BLOCK_TIME.getTime() / 1000), ...spec, signature }));
  return signature;
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BurnError);
  expect((err as BurnError).code).toBe(code);
}

beforeEach(async () => {
  db = await freshDb();
  useTokenEnv();
  chain = fakeChain();
  ws = await newWorkspace();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("verifyBurn", () => {
  it("credits a classic Token program burn with a memo", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn).toMatchObject({
      signature: sig,
      workspaceId: ws.id,
      amountUi: "1000000",
      priceUsd: "0.001",
      usdValue: "1000",
      creditMicroUsd: 1_000_000_000,
      status: "credited",
      blockTime: BLOCK_TIME.toISOString(),
    });
    expect(await getBalance(ws.id)).toBe(1_000_000_000);
    expect(chain.calls.rpc).toEqual(["getTransaction"]);
  });

  it("credits a Token-2022 burnChecked made inside a CPI (inner instruction)", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: "2500000", checked: true, token2022: true, inner: true }], memo: ` ${ws.memo} ` });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn.amountUi).toBe("2.5");
    expect(burn.creditMicroUsd).toBe(2_500); // 2.5 tokens * $0.001
    expect(await getBalance(ws.id)).toBe(2_500);
  });

  it("accepts the Memo v1 program", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo, memoV1: true });
    expect((await verifyBurn(sig, { now: NOW })).status).toBe("credited");
  });

  it("rejects a burn of a different mint", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION, mint: OTHER_MINT }], memo: ws.memo });
    await expectCode(verifyBurn(sig, { now: NOW }), "wrong_mint");
  });

  it("rejects a transaction with no burn", async () => {
    await steadyPrice();
    const sig = put({ burns: [], memo: ws.memo });
    await expectCode(verifyBurn(sig, { now: NOW }), "no_burn");
  });

  it("rejects a burn without a memo", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: null });
    await expectCode(verifyBurn(sig, { now: NOW }), "bad_memo");
  });

  it("rejects a memo for a workspace that does not exist", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: "forkbomb:ws_AAAAAAAAAAAAAAAAAAAA" });
    await expectCode(verifyBurn(sig, { now: NOW }), "unknown_workspace");
  });

  it("rejects a memo with extra text, before or after", async () => {
    await steadyPrice();
    await expectCode(verifyBurn(put({ burns: [{ amount: ONE_MILLION }], memo: `${ws.memo} thanks` }), { now: NOW }), "bad_memo");
    await expectCode(verifyBurn(put({ burns: [{ amount: ONE_MILLION }], memo: `gm ${ws.memo}` }), { now: NOW }), "bad_memo");
    await expectCode(verifyBurn(put({ burns: [{ amount: ONE_MILLION }], memo: `${ws.memo}:x` }), { now: NOW }), "bad_memo");
    expect(await getBalance(ws.id)).toBe(0);
  });

  it("rejects two memos that both claim a workspace", async () => {
    await steadyPrice();
    const other = await newWorkspace();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: [ws.memo, other.memo] });
    await expectCode(verifyBurn(sig, { now: NOW }), "bad_memo");
  });

  it("rejects a failed transaction", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo, err: { InstructionError: [1, { Custom: 1 }] } });
    await expectCode(verifyBurn(sig, { now: NOW }), "failed_tx");
  });

  it("reports not_finalized and not_found from signature status", async () => {
    const pending = randomSignature();
    chain.statuses.set(pending, { confirmationStatus: "confirmed", err: null });
    await expectCode(verifyBurn(pending, { now: NOW }), "not_finalized");
    await expectCode(verifyBurn(randomSignature(), { now: NOW }), "not_found");
    await expectCode(verifyBurn("not-a-signature", { now: NOW }), "invalid_signature");
  });

  it("rejects a burn whose amount disagrees with the account's balance change", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo, postOverride: { [ATA]: "4999999999999" } });
    await expectCode(verifyBurn(sig, { now: NOW }), "balance_mismatch");
  });

  it("sums two burns of our mint in one transaction", async () => {
    await steadyPrice();
    const sig = put({
      burns: [{ amount: ONE_MILLION }, { amount: "500000000000", account: ATA_2, checked: true }],
      memo: ws.memo,
    });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn.amountUi).toBe("1500000");
    expect(burn.creditMicroUsd).toBe(1_500_000_000);
  });

  it("counts only our mint when another mint is burned alongside", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }, { amount: "999000000000000", mint: OTHER_MINT }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn.amountUi).toBe("1000000");
    expect(burn.mint).toBe(MINT);
    expect(burn.creditMicroUsd).toBe(1_000_000_000);
  });

  it("is idempotent: a replayed signature returns the record and credits nothing", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    await verifyBurn(sig, { now: NOW });
    const again = await verifyBurn(sig, { now: NOW });
    expect(again.status).toBe("already_credited");
    expect(again.creditMicroUsd).toBe(1_000_000_000);
    expect(await getBalance(ws.id)).toBe(1_000_000_000);
    expect(chain.calls.rpc).toEqual(["getTransaction"]); // the replay never hit the RPC
  });

  it("credits once when the same signature is verified concurrently", async () => {
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const results = await Promise.all(Array.from({ length: 6 }, () => verifyBurn(sig, { now: NOW })));
    expect(results.filter((r) => r.status === "credited")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_credited")).toHaveLength(5);
    expect(await getBalance(ws.id)).toBe(1_000_000_000);
    const ledger = await db.query("SELECT * FROM credit_ledger");
    expect(ledger).toHaveLength(1);
  });

  it("rejects an old burn when the price window has fewer than 2 samples", async () => {
    await seedSamples(db, BLOCK_TIME, [[-40 * MIN, "0.001"], [2 * MIN, "0.001"], [30 * MIN, "0.001"]]);
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    await expectCode(verifyBurn(sig, { now: NOW }), "too_old_for_price");
    expect(await getBalance(ws.id)).toBe(0);
  });

  it("does not let a price spike after the burn raise the credit", async () => {
    // Steady $0.001 before the burn, then a 4x pump right after it (inside the +5 min window).
    await seedSamples(db, BLOCK_TIME, [
      [-15 * MIN, "0.001"],
      [-10 * MIN, "0.001"],
      [-5 * MIN, "0.001"],
      [-1 * MIN, "0.001"],
      [1 * MIN, "0.004"],
      [4 * MIN, "0.004"],
    ]);
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn.priceUsd).toBe("0.001");
    expect(burn.creditMicroUsd).toBe(1_000_000_000);
  });

  it("credits a recent burn at the pre-burn price, not a later sample or the live quote (regression)", async () => {
    const now = new Date(BLOCK_TIME.getTime() + 9 * MIN);
    await seedSamples(db, BLOCK_TIME, [[-3 * MIN, "0.001"], [7 * MIN, "0.003"]]);
    chain.jupiter = 0.003;
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now });
    expect(burn.priceUsd).toBe("0.001");
    expect(await getBalance(ws.id)).toBe(1_000_000_000);
  });

  it("does not let a pump just before the burn pass at spot: the TWAP dilutes it", async () => {
    await seedSamples(db, BLOCK_TIME, [
      [-15 * MIN, "0.001"],
      [-10 * MIN, "0.001"],
      [-5 * MIN, "0.001"],
      [-1 * MIN, "0.004"],
      [0, "0.004"],
      [5 * MIN, "0.004"],
    ]);
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(Number(burn.priceUsd)).toBeLessThan(0.004);
    expect(burn.creditMicroUsd).toBeLessThan(4_000_000_000);
  });

  it("prices a burn under 10 minutes old at min(latest sample, live quote)", async () => {
    const now = new Date(BLOCK_TIME.getTime() + 2 * MIN);
    await seedSamples(db, BLOCK_TIME, [[-3 * MIN, "0.002"]]);
    chain.jupiter = 0.0015;
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now });
    expect(burn.priceUsd).toBe("0.0015");
    expect(burn.creditMicroUsd).toBe(1_500_000_000);
  });

  it("holds a burn above the per-burn cap for review and credits nothing", async () => {
    useTokenEnv({ MAX_CREDIT_PER_BURN_USD: "500" });
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    const burn = await verifyBurn(sig, { now: NOW });
    expect(burn.status).toBe("review");
    expect(await getBalance(ws.id)).toBe(0);
    expect((await verifyBurn(sig, { now: NOW })).status).toBe("review");
  });

  it("applies CREDIT_MULTIPLIER", async () => {
    useTokenEnv({ CREDIT_MULTIPLIER: "1.5" });
    await steadyPrice();
    const sig = put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo });
    expect((await verifyBurn(sig, { now: NOW })).creditMicroUsd).toBe(1_500_000_000);
  });

  it("refuses before launch when TOKEN_MINT is unset", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    await expectCode(verifyBurn(randomSignature(), { now: NOW }), "not_configured");
  });
});

describe("valueBurn", () => {
  it("floors with integer math at tiny prices", () => {
    const price = parseDecimal("0.000000123456789", PRICE_SCALE);
    const v = valueBurn(123_456_789_000_000n, 6, price, 1_000_000n); // 123,456,789 tokens
    expect(v.usdValue).toBe("15.241578"); // 15.241578750190521 floored to 6 dp
    expect(v.creditMicroUsd).toBe(15_241_578);
  });
});

describe("listLedger", () => {
  it("pages newest first with totals and hides workspace ids", async () => {
    await seedSamples(db, BLOCK_TIME, [-30, -20, -15, -10, -5, 0, 5, 10].map((m) => [m * MIN, "0.001"] as [number, string]));
    const sigs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const blockTime = Math.floor(BLOCK_TIME.getTime() / 1000) - i * 60;
      sigs.push(put({ burns: [{ amount: ONE_MILLION }], memo: ws.memo, blockTime }));
      await verifyBurn(sigs[i]!, { now: NOW });
    }
    const first = await listLedger({ limit: 2 });
    expect(first.burns.map((b) => b.signature)).toEqual(sigs.slice(0, 2));
    expect(first.totals).toEqual({ burnedUi: "3000000", burnedUsd: "3000", burns: 3, creditedMicroUsd: 3_000_000_000 });
    expect(first.burns[0]).not.toHaveProperty("workspaceId");
    expect(first.burns[0]!.owner).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const second = await listLedger({ limit: 2, cursor: first.nextCursor });
    expect(second.burns.map((b) => b.signature)).toEqual(sigs.slice(2));
    expect(second.nextCursor).toBeNull();
  });
});
