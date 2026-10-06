import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../lib/server/db";
import { formatScaled, parseDecimal, PRICE_SCALE } from "../lib/server/decimal";
import { burnPrice, fetchQuote, latestSample, priceSummary, PriceError, samplePrice, timeWeightedAverage } from "../lib/server/price";
import { MINT } from "./fixtures/transactions";
import { fakeChain, freshDb, MIN, seedSamples, useTokenEnv, type FakeChain } from "./helpers";

const p = (s: string) => parseDecimal(s, PRICE_SCALE);
let db: Db;
let chain: FakeChain;

beforeEach(async () => {
  db = await freshDb();
  useTokenEnv();
  chain = fakeChain();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("decimal", () => {
  it("parses plain and exponent forms exactly, flooring past the scale", () => {
    expect(parseDecimal("1.5", 6)).toBe(1_500_000n);
    expect(parseDecimal(1.2e-7, 18)).toBe(120_000_000_000n);
    expect(parseDecimal("0.1234567", 6)).toBe(123_456n);
    expect(parseDecimal("12", 0)).toBe(12n);
    expect(() => parseDecimal("-1", 6)).toThrow();
    expect(() => parseDecimal("abc", 6)).toThrow();
    expect(formatScaled(1_500_000n, 6)).toBe("1.5");
    expect(formatScaled(5n, 18)).toBe("0.000000000000000005");
  });
});

describe("timeWeightedAverage", () => {
  it("weights each sample by how long it held", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 6, 12, m));
    const samples = [
      { ts: t(0), priceAtto: p("1"), source: "x" },
      { ts: t(9), priceAtto: p("2"), source: "x" },
    ];
    // 1 for 9 minutes, 2 for 1 minute
    expect(formatScaled(timeWeightedAverage(samples, t(10)), PRICE_SCALE)).toBe("1.1");
  });
});

describe("fetchQuote", () => {
  it("prefers Jupiter and falls back to DexScreener (most liquid pair)", async () => {
    chain.jupiter = 0.002;
    chain.dexscreener = 0.0021;
    expect(await fetchQuote(MINT)).toEqual({ priceAtto: p("0.002"), source: "jupiter" });
    chain.jupiter = null;
    expect(await fetchQuote(MINT)).toEqual({ priceAtto: p("0.0021"), source: "dexscreener" });
    chain.dexscreener = null;
    await expect(fetchQuote(MINT)).rejects.toBeInstanceOf(PriceError);
  });

  it("rejects a >5x jump unless the second source agrees", async () => {
    chain.jupiter = 0.06;
    chain.dexscreener = 0.001;
    await expect(fetchQuote(MINT, p("0.01"))).rejects.toThrow(/over 5x/);
    chain.dexscreener = 0.058;
    expect((await fetchQuote(MINT, p("0.01"))).priceAtto).toBe(p("0.06"));
    chain.jupiter = 0.04; // 4x: no second source needed
    chain.dexscreener = null;
    expect((await fetchQuote(MINT, p("0.01"))).priceAtto).toBe(p("0.04"));
  });

  it("rejects non-positive prices", async () => {
    chain.jupiter = 0;
    chain.dexscreener = null;
    await expect(fetchQuote(MINT)).rejects.toBeInstanceOf(PriceError);
  });
});

describe("samplePrice", () => {
  it("stores a sane sample and refuses an unconfirmed spike", async () => {
    chain.jupiter = 0.001;
    const t0 = new Date("2026-10-06T12:00:00Z");
    await samplePrice(t0);
    chain.jupiter = 0.5; // 500x, no second source
    await expect(samplePrice(new Date(t0.getTime() + 5 * MIN))).rejects.toBeInstanceOf(PriceError);
    const latest = await latestSample(MINT);
    expect(latest?.priceAtto).toBe(p("0.001"));
    expect(await db.query("SELECT * FROM price_samples")).toHaveLength(1);
  });
});

describe("burnPrice", () => {
  const bt = new Date("2026-10-06T12:00:00Z");
  const later = new Date(bt.getTime() + 60 * MIN);

  it("is the min of window TWAP, nearest sample after and last sample before", async () => {
    await seedSamples(db, bt, [[-10 * MIN, "0.003"], [-2 * MIN, "0.002"], [3 * MIN, "0.0025"]]);
    const r = await burnPrice(bt, later, MINT);
    expect(r).toMatchObject({ ok: true, method: "twap", samples: 3 });
    expect(r.ok && formatScaled(r.priceAtto, PRICE_SCALE)).toBe("0.002");
  });

  it("never uses a live quote for an old burn, and rejects sparse windows", async () => {
    chain.jupiter = 0.0001;
    await seedSamples(db, bt, [[-2 * MIN, "0.002"]]);
    expect(await burnPrice(bt, later, MINT)).toMatchObject({ ok: false, code: "too_old_for_price" });
    expect(chain.calls.price).toEqual([]);
  });

  it("rejects a recent burn with no sample before it, even when a live quote exists", async () => {
    chain.jupiter = 0.001;
    expect(await burnPrice(bt, new Date(bt.getTime() + MIN), MINT)).toMatchObject({ ok: false, code: "too_old_for_price" });
    await seedSamples(db, bt, [[MIN, "0.001"]]); // a sample after the burn is not an anchor either
    expect(await burnPrice(bt, new Date(bt.getTime() + 2 * MIN), MINT)).toMatchObject({ ok: false, code: "too_old_for_price" });
  });

  // Regression: the price was set from data observed after the burn (later samples, the live quote at verify time).
  const at = (r: Awaited<ReturnType<typeof burnPrice>>) => (r.ok ? formatScaled(r.priceAtto, PRICE_SCALE) : r.code);

  it("A: a recent burn uses the pre-burn sample, not a later one or the live quote", async () => {
    chain.jupiter = 0.003;
    await seedSamples(db, bt, [[-3 * MIN, "0.001"], [7 * MIN, "0.003"]]);
    const r = await burnPrice(bt, new Date(bt.getTime() + 9 * MIN), MINT);
    expect(r).toMatchObject({ ok: true, method: "recent" });
    expect(at(r)).toBe("0.001");
  });

  it("B: a stale pre-burn sample is not an anchor, and the live quote alone never prices a burn", async () => {
    chain.jupiter = 0.003;
    await seedSamples(db, bt, [[-40 * MIN, "0.001"]]);
    expect(at(await burnPrice(bt, new Date(bt.getTime() + MIN), MINT))).toBe("too_old_for_price");
  });

  it("C: a window holding only post-burn samples is capped by the anchor before the window", async () => {
    await seedSamples(db, bt, [[-16 * MIN, "0.001"], [MIN, "0.003"], [4 * MIN, "0.003"]]);
    const r = await burnPrice(bt, later, MINT);
    expect(r).toMatchObject({ ok: true, method: "twap", samples: 2 });
    expect(at(r)).toBe("0.001");
  });

  it("lets later data push the price down, never up", async () => {
    chain.jupiter = 0.0005;
    await seedSamples(db, bt, [[-3 * MIN, "0.001"]]);
    expect(at(await burnPrice(bt, new Date(bt.getTime() + MIN), MINT))).toBe("0.0005");
    await seedSamples(db, bt, [[2 * MIN, "0.0007"]]);
    expect(at(await burnPrice(bt, later, MINT))).toBe("0.0007");
  });
});

describe("priceSummary", () => {
  it("is empty before launch and reports latest + TWAP after", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    expect(await priceSummary()).toEqual({ mint: null, latest: null, twap: null });
    useTokenEnv();
    const now = new Date("2026-10-06T12:00:00Z");
    await seedSamples(db, now, [[-10 * MIN, "0.001"], [-5 * MIN, "0.003"]]);
    const s = await priceSummary(now);
    expect(s.latest).toMatchObject({ priceUsd: "0.003", source: "jupiter" });
    expect(s.twap).toEqual({ windowMinutes: 15, priceUsd: "0.002", samples: 2 });
  });
});
