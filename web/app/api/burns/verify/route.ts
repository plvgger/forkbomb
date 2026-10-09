import { verifyBurn } from "@/lib/server/burns";
import { ensureFreshSample } from "@/lib/server/price";
import { ApiError, clientIp, handler, json, otherMethods, readJsonObject } from "@/lib/server/http";
import { hashIp } from "@/lib/server/keys";
import { enforce } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/burns/verify {signature} -> {burn}. Idempotent: a replay returns the stored record
// with status "already_credited". 202 when the burn is held for manual review.
export const POST = handler(async (req: Request) => {
  await enforce("verify", hashIp(clientIp(req)));
  const body = await readJsonObject(req);
  if (typeof body.signature !== "string") throw new ApiError(400, "invalid_signature", "signature is required.");
  // A sample taken after the burn can only lower its price, and gives the next burns an anchor.
  await ensureFreshSample();
  const burn = await verifyBurn(body.signature);
  return json({ burn }, { status: burn.status === "review" ? 202 : 200 });
});
export const { GET, PUT, PATCH, DELETE, OPTIONS } = otherMethods("POST");
