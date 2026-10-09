// USD price of the token: spot quotes from Jupiter (DexScreener fallback), sampled every 5 minutes by the cron
// into price_samples. Burns are priced from the last sample before the burn; later data can only lower the price.

import { getConfig } from "./config";
import { dec, getDb, iso } from "./db";
import { formatScaled, parseDecimal, PRICE_SCALE } from "./decimal";

export const JUPITER_URL = "https://lite-api.jup.ag/price/v3";
export const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex/tokens";
const FETCH_TIMEOUT_MS = 5_000;
/** A quote more than this factor away from the previous sample needs a second source to agree. */
const MAX_JUMP = 5n;
/** Two sources "agree" when within 25% of each other. */
const AGREE_PCT = 25n;

export const BURN_WINDOW_BEFORE_MS = 15 * 60_000;
export const BURN_WINDOW_AFTER_MS = 5 * 60_000;
/** Burns younger than this may be priced with a live quote when samples are sparse. */
export const RECENT_BURN_MS = 10 * 60_000;
/** The latest sample is only used for a recent burn if it is at most this old at burn time. */
const LATEST_SAMPLE_MAX_AGE_MS = 30 * 60_000;
/**
 * blockTime is whole seconds (floored) and runs a second or two behind wall clock, while a sample's ts is exact
 * and taken before its quote is fetched. So the sample a burn panel triggers just before the user sends can carry
 * a ts slightly after the burn's blockTime. When no sample precedes the burn, the first one at most this long
 * after blockTime stands in as the anchor.
 */
export const ANCHOR_SKEW_MS = 5_000;

export type Source = "jupiter" | "dexscreener";
export type Quote = { priceAtto: bigint; source: Source };
export type Sample = { ts: Date; priceAtto: bigint; source: string };

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceError";
  }
}

export const priceToString = (atto: bigint) => formatScaled(atto, PRICE_SCALE);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new PriceError(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

function positive(raw: unknown): bigint | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "number" && !(Number.isFinite(raw) && raw > 0)) return null;
  try {
    const v = parseDecimal(raw, PRICE_SCALE);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export async function fetchJupiter(mint: string): Promise<Quote> {
  const body = (await getJson(`${JUPITER_URL}?ids=${encodeURIComponent(mint)}`)) as Record<string, { usdPrice?: unknown }>;
  const price = positive(body?.[mint]?.usdPrice);
  if (!price) throw new PriceError("jupiter has no usable price for this mint");
  return { priceAtto: price, source: "jupiter" };
}

type DexPair = { chainId?: string; priceUsd?: unknown; baseToken?: { address?: string }; liquidity?: { usd?: number } };

/** The most liquid Solana pair where our mint is the base token. */
export async function fetchDexScreener(mint: string): Promise<Quote> {
  const body = (await getJson(`${DEXSCREENER_URL}/${encodeURIComponent(mint)}`)) as { pairs?: DexPair[] | null };
  const pairs = (body?.pairs ?? [])
    .filter((p) => p.chainId === "solana" && p.baseToken?.address === mint && positive(p.priceUsd))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const price = pairs[0] ? positive(pairs[0].priceUsd) : null;
  if (!price) throw new PriceError("dexscreener has no usable price for this mint");
  return { priceAtto: price, source: "dexscreener" };
}

const FETCHERS: Record<Source, (mint: string) => Promise<Quote>> = { jupiter: fetchJupiter, dexscreener: fetchDexScreener };

const jumped = (a: bigint, b: bigint) => a > b * MAX_JUMP || b > a * MAX_JUMP;
const agree = (a: bigint, b: bigint) => (a > b ? a - b : b - a) * 100n <= (a < b ? a : b) * AGREE_PCT;

/**
 * A sane spot quote: Jupiter first, DexScreener if Jupiter fails. If it is more than 5x away from `previous`,
 * the other source must agree (within 25%) or the quote is rejected. Throws PriceError.
 */
export async function fetchQuote(mint: string, previous?: bigint | null): Promise<Quote> {
  const order: Source[] = ["jupiter", "dexscreener"];
  let quote: Quote | null = null;
  let firstErr: unknown;
  for (const src of order) {
    try {
      quote = await FETCHERS[src](mint);
      break;
    } catch (err) {
      firstErr ??= err;
    }
  }
  if (!quote) throw firstErr instanceof PriceError ? firstErr : new PriceError("no price source answered");
  if (previous && jumped(quote.priceAtto, previous)) {
    const other = order.find((s) => s !== quote.source)!;
    const second = await FETCHERS[other](mint).catch(() => null);
    if (!second || !agree(second.priceAtto, quote.priceAtto)) {
      throw new PriceError(
        `quote ${priceToString(quote.priceAtto)} from ${quote.source} is over 5x from the last sample ${priceToString(previous)} and no second source agrees`,
      );
    }
  }
  return quote;
}

function toSample(r: { ts: unknown; price_usd: unknown; source: string }): Sample {
  return { ts: new Date(iso(r.ts)), priceAtto: parseDecimal(dec(r.price_usd), PRICE_SCALE), source: r.source };
}

export async function latestSample(mint = getConfig().tokenMint, atOrBefore?: Date): Promise<Sample | null> {
  const db = await getDb();
  const rows = await db.query<{ ts: unknown; price_usd: unknown; source: string }>(
    `SELECT ts, price_usd::text AS price_usd, source FROM price_samples
     WHERE mint = $1 AND ($2::timestamptz IS NULL OR ts <= $2::timestamptz) ORDER BY ts DESC, id DESC LIMIT 1`,
    [mint, atOrBefore ? atOrBefore.toISOString() : null],
  );
  return rows[0] ? toSample(rows[0]) : null;
}

export async function samplesBetween(mint: string, from: Date, to: Date): Promise<Sample[]> {
  const db = await getDb();
  const rows = await db.query<{ ts: unknown; price_usd: unknown; source: string }>(
    `SELECT ts, price_usd::text AS price_usd, source FROM price_samples
     WHERE mint = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC, id ASC`,
    [mint, from.toISOString(), to.toISOString()],
  );
  return rows.map(toSample);
}

/** Fetch a sane quote and store it as a sample. Throws PriceError (nothing stored) when no sane quote exists. */
export async function samplePrice(now: Date = new Date()): Promise<Sample> {
  const mint = getConfig().tokenMint;
  if (!mint) throw new PriceError("TOKEN_MINT is not set");
  const prev = await latestSample(mint);
  const quote = await fetchQuote(mint, prev?.priceAtto);
  const db = await getDb();
  await db.query("INSERT INTO price_samples (mint, ts, price_usd, source) VALUES ($1, $2, $3, $4)", [
    mint,
    now.toISOString(),
    priceToString(quote.priceAtto),
    quote.source,
  ]);
  return { ts: now, priceAtto: quote.priceAtto, source: quote.source };
}

/** A read of the price takes a new sample when the latest is older than this (see ensureFreshSample). */
export const ON_DEMAND_MAX_AGE_MS = 2 * 60_000;
let sampling: Promise<Sample | null> | null = null;

/**
 * Samples now if the latest sample is ON_DEMAND_MAX_AGE_MS old or older. Burns are priced from samples, and a
 * burn with no sample in the 30 minutes before it can never be credited, so sampling can't depend on a scheduler
 * alone (GitHub delays or drops scheduled runs). The burn panel reads /api/price every minute while open, so
 * whoever is about to burn keeps a fresh pre-burn sample in place. At most one sample per instance at a time.
 * Never throws: returns the new sample, or null when none was needed or the price sources failed (logged).
 */
export async function ensureFreshSample(now: Date = new Date(), maxAgeMs = ON_DEMAND_MAX_AGE_MS): Promise<Sample | null> {
  const mint = getConfig().tokenMint;
  if (!mint) return null;
  try {
    const latest = await latestSample(mint, now);
    if (latest && now.getTime() - latest.ts.getTime() < maxAgeMs) return null;
  } catch (err) {
    console.error("[price] on-demand sample check failed", err);
    return null;
  }
  sampling ??= samplePrice(now)
    .catch((err: unknown) => {
      console.error("[price] on-demand sample failed", err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => {
      sampling = null;
    });
  return sampling;
}

/**
 * Time-weighted average of samples (sorted by ts) up to windowEnd: each sample holds until the next one,
 * the last until windowEnd. Falls back to the plain mean when all samples share one instant. Floors.
 */
export function timeWeightedAverage(samples: Sample[], windowEnd: Date): bigint {
  if (!samples.length) throw new RangeError("no samples");
  let weighted = 0n;
  let total = 0n;
  samples.forEach((s, i) => {
    const until = i + 1 < samples.length ? samples[i + 1]!.ts.getTime() : Math.max(windowEnd.getTime(), s.ts.getTime());
    const w = BigInt(until - s.ts.getTime());
    weighted += s.priceAtto * w;
    total += w;
  });
  if (total === 0n) return samples.reduce((a, s) => a + s.priceAtto, 0n) / BigInt(samples.length);
  return weighted / total;
}

export type BurnPrice =
  | { ok: true; priceAtto: bigint; method: "twap" | "recent"; samples: number }
  | { ok: false; code: "too_old_for_price" | "price_unavailable"; message: string };

/**
 * The USD price a burn at blockTime is credited at. Never to the burner's advantage: every price is anchored
 * to the last sample at/before blockTime (at most 30 minutes old), and anything observed after the burn (later
 * samples, the window TWAP, a live quote) can only push it down, never set it.
 * - No pre-burn anchor: the first sample at most ANCHOR_SKEW_MS after blockTime anchors instead (clock skew,
 *   see there). Otherwise rejected (too_old_for_price): a price fetched later can't stand in for it.
 * - 2+ samples in [blockTime-15m, blockTime+5m]: MIN(anchor, window TWAP, nearest sample after blockTime),
 *   plus a live quote if the burn is under 10 minutes old and no sample after it exists yet.
 * - Fewer: rejected (too_old_for_price) unless the burn is under 10 minutes old; then MIN(anchor, live quote).
 */
export async function burnPrice(
  blockTime: Date,
  now: Date = new Date(),
  mint = getConfig().tokenMint,
  liveQuote: (mint: string, prev?: bigint | null) => Promise<Quote> = fetchQuote,
): Promise<BurnPrice> {
  const bt = blockTime.getTime();
  const before = await latestSample(mint, blockTime);
  const anchor =
    before && bt - before.ts.getTime() <= LATEST_SAMPLE_MAX_AGE_MS
      ? before
      : ((await samplesBetween(mint, blockTime, new Date(bt + ANCHOR_SKEW_MS)))[0] ?? null);
  if (!anchor) {
    return {
      ok: false,
      code: "too_old_for_price",
      message: `No price sample was recorded in the ${LATEST_SAMPLE_MAX_AGE_MS / 60_000} minutes before this burn, so it can't be priced. Contact support with the signature.`,
    };
  }

  const from = new Date(bt - BURN_WINDOW_BEFORE_MS);
  const to = new Date(Math.min(bt + BURN_WINDOW_AFTER_MS, now.getTime()));
  const samples = await samplesBetween(mint, from, to);
  const recent = now.getTime() - bt <= RECENT_BURN_MS;
  const after = samples.find((s) => s.ts.getTime() >= bt);
  const candidates = [anchor.priceAtto];
  const pushDownWithLiveQuote = async () => {
    const live = await liveQuote(mint, anchor.priceAtto).then((q) => q.priceAtto, () => null);
    if (live !== null) candidates.push(live);
  };

  if (samples.length < 2) {
    if (!recent) {
      return {
        ok: false,
        code: "too_old_for_price",
        message: "Not enough price samples around this burn's time to price it. Contact support with the signature.",
      };
    }
    if (after) candidates.push(after.priceAtto);
    await pushDownWithLiveQuote();
    return { ok: true, priceAtto: min(candidates), method: "recent", samples: samples.length };
  }

  candidates.push(timeWeightedAverage(samples, to));
  if (after) candidates.push(after.priceAtto);
  else if (recent) await pushDownWithLiveQuote();
  return { ok: true, priceAtto: min(candidates), method: "twap", samples: samples.length };
}

const min = (xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/** For GET /api/price: latest sample and the 15-minute TWAP ending now. */
export async function priceSummary(now: Date = new Date()) {
  const mint = getConfig().tokenMint;
  if (!mint) return { mint: null, latest: null, twap: null };
  const latest = await latestSample(mint, now);
  const window = await samplesBetween(mint, new Date(now.getTime() - BURN_WINDOW_BEFORE_MS), now);
  return {
    mint,
    latest: latest && { ts: latest.ts.toISOString(), priceUsd: priceToString(latest.priceAtto), source: latest.source },
    twap: window.length
      ? { windowMinutes: BURN_WINDOW_BEFORE_MS / 60_000, priceUsd: priceToString(timeWeightedAverage(window, now)), samples: window.length }
      : null,
  };
}
