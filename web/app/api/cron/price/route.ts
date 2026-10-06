import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { expireStaleReservations } from "@/lib/server/credits";
import { ApiError, handler, json } from "@/lib/server/http";
import { PriceError, priceToString, samplePrice } from "@/lib/server/price";
import { pruneRateLimits } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every 5 minutes: sample the token price, refund stale reservations, prune old rate-limit windows.
// Auth: "Authorization: Bearer $CRON_SECRET". Vercel Cron sends it automatically when CRON_SECRET is set.
// Vercel Hobby only runs crons daily, so vercel.json schedules a daily safety run; point an external
// pinger (cron-job.org, GitHub Actions, UptimeRobot) at GET or POST /api/cron/price every 5 minutes with that header.
async function run(req: Request): Promise<Response> {
  const secret = getConfig().cronSecret;
  const given = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError(401, "unauthorized", "Missing or wrong cron secret.");
  }

  const expired = await expireStaleReservations();
  await pruneRateLimits();
  if (!getConfig().tokenMint) return json({ sample: null, skipped: "TOKEN_MINT not set", expiredReservations: expired });

  try {
    const s = await samplePrice();
    return json({
      sample: { ts: s.ts.toISOString(), priceUsd: priceToString(s.priceAtto), source: s.source },
      expiredReservations: expired,
    });
  } catch (err) {
    console.error("[cron/price] sample failed", err);
    const message = err instanceof PriceError ? err.message : "price sample failed";
    return json({ sample: null, error: message, expiredReservations: expired }, { status: 502 });
  }
}

export const GET = handler(run);
export const POST = handler(run);
