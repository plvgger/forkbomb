import { handler, json, PUBLIC_SHORT } from "@/lib/server/http";
import { priceSummary } from "@/lib/server/price";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/price -> {mint, latest:{ts, priceUsd, source}, twap:{windowMinutes, priceUsd, samples}}.
// Prices are decimal strings. All null before launch (TOKEN_MINT unset).
export const GET = handler(async () => json(await priceSummary(), { cache: PUBLIC_SHORT }));
