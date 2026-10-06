import { handler, json, PUBLIC_SHORT } from "@/lib/server/http";
import { tokenInfo } from "./token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/token -> {ticker, mint, decimals, program, burnsOpen, memoPrefix, cluster, creditMultiplier, maxCreditPerBurnUsd}.
// mint/decimals/program are null and burnsOpen is false until launch (TOKEN_MINT unset) or when the mint can't be read.
export const GET = handler(async () => json(await tokenInfo(), { cache: PUBLIC_SHORT }));
