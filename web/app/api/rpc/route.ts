import { clientIp, handler, json, otherMethods, readJsonObject } from "@/lib/server/http";
import { hashIp } from "@/lib/server/keys";
import { enforce } from "@/lib/server/ratelimit";
import { assertSameSite, forwardRpc, parseRpcCall, RPC_MAX_BODY_BYTES } from "./proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rpc {jsonrpc:"2.0", id, method, params} -> {jsonrpc, id, result|error}.
// Allowlisted read methods only (see proxy.ts), one call per request, 2 KB body cap, this site's pages only
// (JSON content type, no cross-site Sec-Fetch-Site), a per-IP rate limit (the "rpc" bucket, RATE_RPC_PER_MINUTE)
// and one for all callers together (the "rpc_global" bucket, RATE_RPC_GLOBAL_PER_MINUTE).
export const POST = handler(async (req: Request) => {
  assertSameSite(req);
  await enforce("rpc", hashIp(clientIp(req)));
  await enforce("rpc_global", "all");
  const call = parseRpcCall(await readJsonObject(req, RPC_MAX_BODY_BYTES));
  return json(await forwardRpc(call));
});
export const { GET, PUT, PATCH, DELETE, OPTIONS } = otherMethods("POST");
