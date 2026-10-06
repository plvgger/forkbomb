import { describe, expect, it } from "vitest";
import {
  estimateCreditMicroUsd,
  formatRaw,
  formatRawGrouped,
  lowerPrice,
  parseScaled,
  parseUiAmount,
  PRICE_FRESH_MS,
  priceIsFresh,
  U64_MAX,
} from "../app/app/_lib/amount";
import { shouldRetry, verifyCopy } from "../app/app/_lib/burnErrors";
import { explorerTx, maskKey, setupSnippet } from "../app/app/_lib/snippet";
import { valueBurn, type BurnErrorCode } from "../lib/server/burns";

const raw = (input: string, decimals = 6) => {
  const r = parseUiAmount(input, decimals);
  return r.ok ? r.raw : r.error;
};

describe("parseUiAmount", () => {
  it("parses decimals exactly", () => {
    expect(raw("1")).toBe(1_000_000n);
    expect(raw("1.5")).toBe(1_500_000n);
    expect(raw(".5")).toBe(500_000n);
    expect(raw("5.")).toBe(5_000_000n);
    expect(raw("  007.000001 ")).toBe(7_000_001n);
    expect(raw("0.000001")).toBe(1n);
    expect(raw("123456789.123456789", 9)).toBe(123_456_789_123_456_789n);
    expect(raw("15", 0)).toBe(15n);
  });

  it("rejects what a burn can't take", () => {
    expect(raw("")).toMatch(/Enter an amount/);
    expect(raw("   ")).toMatch(/Enter an amount/);
    expect(raw("0")).toMatch(/more than zero/);
    expect(raw("0.0000000")).toMatch(/decimal places/);
    expect(raw("0.000000")).toMatch(/more than zero/);
    expect(raw("-1")).toMatch(/digits/);
    expect(raw("1e5")).toMatch(/digits/);
    expect(raw("1,000")).toMatch(/digits/);
    expect(raw("1.2.3")).toMatch(/digits/);
    expect(raw(".")).toMatch(/digits/);
    expect(raw("0x10")).toMatch(/digits/);
    expect(raw("1.1234567")).toMatch(/At most 6 decimal places/);
    expect(raw("1.5", 0)).toMatch(/whole number/);
    expect(raw("1", 19)).toMatch(/decimals unknown/);
  });

  it("caps at u64", () => {
    expect(raw(U64_MAX.toString(), 0)).toBe(U64_MAX);
    expect(raw((U64_MAX + 1n).toString(), 0)).toMatch(/too large/);
    expect(raw("18446744073709.551616", 6)).toMatch(/too large/);
  });
});

describe("formatRaw", () => {
  it("round-trips with parseUiAmount", () => {
    for (const [r, d] of [
      [1n, 6],
      [1_500_000n, 6],
      [10n ** 18n, 9],
      [U64_MAX, 6],
      [42n, 0],
    ] as const) {
      const s = formatRaw(r, d);
      expect(raw(s, d)).toBe(r);
    }
    expect(formatRaw(0n, 6)).toBe("0");
    expect(formatRaw(1_500_000n, 6)).toBe("1.5");
  });

  it("groups for reading and cuts the fraction", () => {
    expect(formatRawGrouped(1_234_567_891_234n, 6)).toBe("1,234,567.891234");
    expect(formatRawGrouped(1_234_567_891_234n, 6, 2)).toBe("1,234,567.89");
    expect(formatRawGrouped(1_000_000n, 6, 2)).toBe("1");
  });
});

describe("credit estimate", () => {
  it("matches the server's valueBurn at multiplier 1", () => {
    const priceUsd = "0.000123456789";
    const r = 987_654_321_000n; // 987,654.321 tokens at 6 decimals
    const server = valueBurn(r, 6, parseScaled(priceUsd, 18)!, 1_000_000n).creditMicroUsd;
    expect(estimateCreditMicroUsd(r, 6, priceUsd, "1")).toBe(server);
    expect(server).toBeGreaterThan(0);
  });

  it("applies the multiplier and handles missing prices", () => {
    expect(estimateCreditMicroUsd(1_000_000n, 6, "0.5", "1")).toBe(500_000);
    expect(estimateCreditMicroUsd(1_000_000n, 6, "0.5", "1.5")).toBe(750_000);
    expect(estimateCreditMicroUsd(1_000_000n, 6, null, "1")).toBeNull();
    expect(estimateCreditMicroUsd(1_000_000n, 6, "0", "1")).toBeNull();
    expect(estimateCreditMicroUsd(1_000_000n, 6, "abc", "1")).toBeNull();
  });

  it("previews with the lower of spot and TWAP", () => {
    expect(lowerPrice("0.002", "0.0015")).toBe("0.0015");
    expect(lowerPrice("0.001", "0.0015")).toBe("0.001");
    expect(lowerPrice(null, "0.0015")).toBe("0.0015");
    expect(lowerPrice("0.002", null)).toBe("0.002");
    expect(lowerPrice(null, null)).toBeNull();
  });

  it("only allows burning while the last price sample is fresh", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(priceIsFresh(new Date(now - 60_000).toISOString(), now)).toBe(true);
    expect(priceIsFresh(new Date(now - PRICE_FRESH_MS - 1).toISOString(), now)).toBe(false);
    expect(priceIsFresh(null, now)).toBe(false);
  });
});

describe("verify copy", () => {
  // Every code burns.ts can return. The type check fails if burns.ts adds one this list misses.
  const CODES = [
    "invalid_signature",
    "not_configured",
    "not_found",
    "not_finalized",
    "failed_tx",
    "wrong_mint",
    "no_burn",
    "bad_memo",
    "balance_mismatch",
    "unknown_workspace",
    "too_old_for_price",
    "price_unavailable",
    "rpc_error",
  ] as const satisfies readonly BurnErrorCode[];
  const exhaustive: Exclude<BurnErrorCode, (typeof CODES)[number]> extends never ? true : false = true;

  it("has human copy for every burn error code", () => {
    expect(exhaustive).toBe(true);
    for (const code of CODES) {
      const c = verifyCopy(code, "$FORKBOMB");
      expect(c.title).not.toBe("Verification failed");
      expect(c.body.length).toBeGreaterThan(20);
    }
  });

  it("keeps polling only while the burn may still land", () => {
    const retry = CODES.filter((c) => verifyCopy(c, "").retry);
    expect(retry.sort()).toEqual(["not_finalized", "not_found", "price_unavailable", "rpc_error"]);
    expect(shouldRetry("rate_limited", 429)).toBe(true);
    expect(shouldRetry("internal_error", 500)).toBe(true);
    expect(shouldRetry("not_configured", 503)).toBe(false);
    expect(shouldRetry("bad_memo", 422)).toBe(false);
  });
});

describe("dashboard helpers", () => {
  const KEY = "forkbomb_sk_0123456789abcdefghijABCDEFGHIJkl";

  it("masks the key", () => {
    expect(maskKey(KEY)).toBe("forkbomb_sk_0123…IJkl");
    expect(maskKey(KEY)).not.toContain("456789");
  });

  it("builds the setup snippet", () => {
    const snip = setupSnippet(KEY, null);
    expect(snip).toContain(`export FORKBOMB_API_KEY=${KEY}`);
    expect(snip).toContain("node dist/cli.js run ./repo --engine hosted");
    expect(snip).toContain('--task "');
    expect(snip).toContain('--test "');
    expect(snip).not.toContain("FORKBOMB_HOSTED_URL");
    expect(setupSnippet(KEY, "https://preview.example")).toContain("export FORKBOMB_HOSTED_URL=https://preview.example/api/v1");
  });

  it("links Solscan on the right cluster", () => {
    expect(explorerTx("abc", "mainnet")).toBe("https://solscan.io/tx/abc");
    expect(explorerTx("abc", "devnet")).toBe("https://solscan.io/tx/abc?cluster=devnet");
  });
});
