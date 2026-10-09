// Token amounts as exact integers. The user types a decimal ("1,250.5" is not accepted, "1250.5" is);
// we turn it into raw base units with no float on the way, and back for display.

export const U64_MAX = 2n ** 64n - 1n;

export type ParsedAmount = { ok: true; raw: bigint } | { ok: false; error: string };

const AMOUNT_RE = /^(\d*)(?:\.(\d*))?$/;

/** "12.5" with 6 decimals -> 12_500_000n. Rejects empty, zero, negatives, exponents, extra decimals and > u64. */
export function parseUiAmount(input: string, decimals: number): ParsedAmount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { ok: false, error: "Token decimals unknown." };
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter an amount." };
  const m = AMOUNT_RE.exec(s);
  if (!m || (!m[1] && !m[2])) return { ok: false, error: "Use digits and one dot, like 1500 or 12.5." };
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return {
      ok: false,
      error: decimals === 0 ? "This token has no decimals. Enter a whole number." : `At most ${decimals} decimal places.`,
    };
  }
  const raw = BigInt((whole || "0") + frac.padEnd(decimals, "0"));
  if (raw === 0n) return { ok: false, error: "Amount must be more than zero." };
  if (raw > U64_MAX) return { ok: false, error: "That amount is too large." };
  return { ok: true, raw };
}

/** 12_500_000n with 6 decimals -> "12.5". Exact, no trailing zeros, no grouping (safe to put back in the input). */
export function formatRaw(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Same as formatRaw with thousands separators, for reading. */
export function formatRawGrouped(raw: bigint, decimals: number, maxFrac = decimals): string {
  const [whole, frac = ""] = formatRaw(raw, decimals).split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cut ? `.${cut}` : ""}`;
}

/** A non-negative decimal string ("0.000123", "1") as an integer scaled by 10^scale, floored. Null if unreadable. */
export function parseScaled(input: string | null | undefined, scale: number): bigint | null {
  const m = AMOUNT_RE.exec(String(input ?? "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] ?? "").slice(0, scale).padEnd(scale, "0");
  return BigInt((m[1] || "0") + frac);
}

/**
 * Estimated credit (micro-USD, floored) for burning `raw` at `priceUsd` with `multiplier` credit per USD.
 * Mirrors the server's valueBurn: usd = raw * price / 10^decimals, credit = usd * multiplier. Null if inputs are unreadable.
 */
export function estimateCreditMicroUsd(raw: bigint, decimals: number, priceUsd: string | null, multiplier: string): number | null {
  const priceAtto = parseScaled(priceUsd, 18);
  const multPpm = parseScaled(multiplier, 6);
  if (priceAtto === null || multPpm === null || priceAtto <= 0n) return null;
  const usdAtto = (raw * priceAtto) / 10n ** BigInt(decimals);
  const micro = (usdAtto * multPpm) / 10n ** 18n;
  return micro > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micro);
}

/** The lower of two decimal price strings (the server never credits above the lowest price it saw). */
export function lowerPrice(a: string | null, b: string | null): string | null {
  const x = parseScaled(a, 18);
  const y = parseScaled(b, 18);
  if (x === null || x <= 0n) return y !== null && y > 0n ? b : null;
  if (y === null || y <= 0n) return a;
  return x <= y ? a : b;
}

/**
 * The server prices a burn from the last price sample before it and rejects the burn if that sample is over
 * 30 minutes old. Allow burning only while the latest sample is younger than this, with margin for the burn to land.
 */
export const PRICE_FRESH_MS = 25 * 60_000;

export function priceIsFresh(sampledAt: string | null, now: number): boolean {
  const t = sampledAt ? Date.parse(sampledAt) : NaN;
  return Number.isFinite(t) && now - t <= PRICE_FRESH_MS;
}

/**
 * When the price read that enabled the panel just took the only recent sample, wait this long before allowing a
 * burn. The server already accepts a sample a few seconds after a burn's blockTime as its anchor (blockTime is
 * whole seconds and lags wall clock: ANCHOR_SKEW_MS in lib/server/price.ts); this keeps a fast burn well clear of
 * that edge. Not needed while the window holds an older sample, which anchors the burn on its own.
 */
export const SAMPLE_SETTLE_MS = 10_000;

/**
 * Milliseconds until a burn may be sent on this price read, 0 when it may go now. Client clock: a sample stamped
 * after readAt (a clock behind the server's) counts from readAt, so the wait never exceeds SAMPLE_SETTLE_MS.
 */
export function sampleSettleLeftMs(sampledAt: string | null, windowSamples: number, readAt: number, now: number): number {
  if (windowSamples >= 2) return 0;
  const t = sampledAt ? Date.parse(sampledAt) : NaN;
  if (!Number.isFinite(t)) return 0; // no sample at all: priceIsFresh already blocks the burn
  return Math.max(0, SAMPLE_SETTLE_MS - (now - Math.min(t, readAt)));
}
