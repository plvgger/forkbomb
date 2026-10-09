import { handler, json, otherMethods, PUBLIC_SHORT } from "@/lib/server/http";
import { ensureFreshSample, priceSummary } from "@/lib/server/price";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/price -> {mint, latest:{ts, priceUsd, source}, twap:{windowMinutes, priceUsd, samples}}.
// Prices are decimal strings. All null before launch (TOKEN_MINT unset).
// Takes a new sample first when the latest is over 2 minutes old: the burn panel polls this while open.
export const GET = handler(async () => {
  await ensureFreshSample();
  return json(await priceSummary(), { cache: PUBLIC_SHORT });
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = otherMethods("GET");
