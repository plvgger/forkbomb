import { clientIp, handler, json, readJsonObject } from "@/lib/server/http";
import { hashIp } from "@/lib/server/keys";
import { enforce } from "@/lib/server/ratelimit";
import { forwardRpc, parseRpcCall, RPC_MAX_BODY_BYTES } from "./proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rpc {jsonrpc:"2.0", id, method, params} -> {jsonrpc, id, result|error}.
// Allowlisted read methods only (see proxy.ts), one call per request, 2 KB body cap, per-IP rate limit
// (the "rpc" bucket, RATE_RPC_PER_MINUTE).
export const POST = handler(async (req: Request) => {
  await enforce("rpc", hashIp(clientIp(req)));
  const call = parseRpcCall(await readJsonObject(req, RPC_MAX_BODY_BYTES));
  return json(await forwardRpc(call));
});
