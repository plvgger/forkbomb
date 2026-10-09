import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { credit, formatMicroUsd } from "@/lib/server/credits";
import { getDb, pgCode } from "@/lib/server/db";
import { ApiError, clientIp, handler, json, otherMethods, readJsonObject } from "@/lib/server/http";
import { hashIp } from "@/lib/server/keys";
import { enforce } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ADMIN_SECRET shorter than this leaves the route switched off. */
export const MIN_ADMIN_SECRET = 32;
const REF = /^[A-Za-z0-9_.:-]{1,64}$/;
const USD = /^\d{1,9}(\.\d{1,6})?$/;

// POST /api/admin/grant {workspaceId, usd, ref} -> {workspaceId, grantedUsd, balanceUsd, ref}
// Operator-only credit grant: test credit before launch, promo credit, or a reviewed burn paid out by hand.
// Auth: "Authorization: Bearer $ADMIN_SECRET". Unset or short secret -> 404, so the route doesn't exist.
// Lands in credit_ledger as reason 'grant', ref 'admin:<ref>'. A ref grants once: a repeat is 409.
// One grant is capped at MAX_GRANT_USD (default 100).
export const POST = handler(async (req: Request) => {
  const cfg = getConfig();
  if (cfg.adminSecret.length < MIN_ADMIN_SECRET) throw new ApiError(404, "not_found", "Not found.");
  await enforce("admin", hashIp(clientIp(req)));
  const given = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${cfg.adminSecret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError(401, "unauthorized", "Missing or wrong admin secret.");
  }

  const body = await readJsonObject(req);
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const usd = typeof body.usd === "string" ? body.usd.trim() : "";
  const ref = typeof body.ref === "string" ? body.ref : "";
  if (!workspaceId) throw new ApiError(400, "invalid_request", "workspaceId is required.");
  if (!REF.test(ref)) throw new ApiError(400, "invalid_request", "ref must be 1-64 characters of A-Z a-z 0-9 _ . : -");
  if (!USD.test(usd)) throw new ApiError(400, "invalid_request", 'usd must be a decimal string like "5" or "2.50".');
  const micro = Number(usd.split(".")[0]) * 1_000_000 + Number((usd.split(".")[1] ?? "").padEnd(6, "0"));
  if (micro <= 0) throw new ApiError(400, "invalid_request", "usd must be more than 0.");
  if (micro > cfg.maxGrantMicroUsd) {
    throw new ApiError(400, "grant_too_large", `One grant is capped at $${formatMicroUsd(cfg.maxGrantMicroUsd)}.`);
  }

  const db = await getDb();
  let balance: number;
  try {
    balance = await db.tx((q) => credit(q, workspaceId, micro, "grant", `admin:${ref}`));
  } catch (err) {
    if (pgCode(err) === "23505") throw new ApiError(409, "duplicate_ref", `ref ${ref} was already granted.`);
    if (pgCode(err) === "23503") throw new ApiError(404, "unknown_workspace", `No workspace ${workspaceId}.`);
    throw err;
  }
  console.info(`[admin/grant] ${workspaceId} +$${formatMicroUsd(micro)} ref=${ref}`);
  return json({ workspaceId, grantedUsd: formatMicroUsd(micro), balanceUsd: formatMicroUsd(balance), ref });
});
export const { GET, PUT, PATCH, DELETE, OPTIONS } = otherMethods("POST");
