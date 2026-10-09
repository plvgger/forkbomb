import { ApiError, handler, json, otherMethods } from "@/lib/server/http";
import { authenticate } from "@/lib/server/keys";
import { workspaceUsage } from "./usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/usage?limit= (Bearer key) -> {usage: newest first, totals}. Read-only.
export const GET = handler(async (req: Request) => {
  const workspace = await authenticate(req);
  const raw = new URL(req.url).searchParams.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) {
    throw new ApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  return json(await workspaceUsage(workspace.id, limit));
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = otherMethods("GET");
