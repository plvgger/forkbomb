import { type LedgerPage, listLedger } from "@/lib/server/burns";
import { getConfig } from "@/lib/server/config";
import { ApiError, handler, json, PUBLIC_SHORT } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/ledger?cursor=&limit= -> public list of verified burns, newest first, plus totals.
// Before launch (TOKEN_MINT unset) nothing can have been burned, so it answers an empty page without the database.
const EMPTY: LedgerPage = { burns: [], nextCursor: null, totals: { burnedUi: "0", burnedUsd: "0", burns: 0, creditedMicroUsd: 0 } };

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) {
    throw new ApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  if (!getConfig().tokenMint) return json(EMPTY, { cache: PUBLIC_SHORT });
  const page = await listLedger({ cursor: url.searchParams.get("cursor"), limit });
  return json(page, { cache: PUBLIC_SHORT });
});
