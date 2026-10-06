// A narrow JSON-RPC proxy to SOLANA_RPC_URL for the /app wallet panel, so the browser never needs the
// (keyed) RPC URL. Only the read calls the burn flow makes (app/app/_lib/rpc.ts) are allowed, token
// account reads are pinned to TOKEN_MINT, and sending goes through the wallet.

import { getConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/http";

export const RPC_METHODS = new Set(["getLatestBlockhash", "getTokenAccountsByOwner", "getSignatureStatuses", "getBalance"]);

/** Request body cap. The largest allowed call (a few signatures) is well under 1 KB. */
export const RPC_MAX_BODY_BYTES = 2 * 1024;
/** Upstream answers larger than this are dropped (a wallet with thousands of token accounts). */
export const RPC_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PARAMS = 3;
const MAX_SIGNATURES = 16;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type RpcCall = { id: string | number | null; method: string; params: unknown[] };

/** Validates one JSON-RPC 2.0 call against the allowlist. Batches are rejected before this (not an object). */
export function parseRpcCall(body: Record<string, unknown>): RpcCall {
  if (body.jsonrpc !== "2.0") throw new ApiError(400, "invalid_rpc_request", 'jsonrpc must be "2.0".');
  const id = body.id ?? null;
  if (!(id === null || typeof id === "number" || (typeof id === "string" && id.length <= 64))) {
    throw new ApiError(400, "invalid_rpc_request", "id must be a number, a short string or null.");
  }
  const method = body.method;
  if (typeof method !== "string" || !RPC_METHODS.has(method)) {
    throw new ApiError(403, "method_not_allowed", `Only these RPC methods are allowed: ${[...RPC_METHODS].join(", ")}.`);
  }
  const params = body.params ?? [];
  if (!Array.isArray(params) || params.length > MAX_PARAMS) {
    throw new ApiError(400, "invalid_rpc_request", `params must be an array of at most ${MAX_PARAMS} items.`);
  }
  if (method === "getTokenAccountsByOwner") {
    const mint = getConfig().tokenMint;
    const filter = params[1] as Record<string, unknown> | null | undefined;
    const keys = filter && typeof filter === "object" && !Array.isArray(filter) ? Object.keys(filter) : [];
    if (!mint || keys.length !== 1 || filter!.mint !== mint) {
      throw new ApiError(403, "mint_not_allowed", "getTokenAccountsByOwner is only allowed with the filter {mint: <token mint>}.");
    }
  }
  if (method === "getSignatureStatuses") {
    const sigs = params[0];
    if (!Array.isArray(sigs) || sigs.length < 1 || sigs.length > MAX_SIGNATURES) {
      throw new ApiError(400, "invalid_rpc_request", `getSignatureStatuses takes 1 to ${MAX_SIGNATURES} signatures.`);
    }
  }
  return { id, method, params };
}

/** Sends one allowed call upstream and returns the JSON-RPC envelope ({result} or {error}) with our id. */
export async function forwardRpc(call: RpcCall): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(getConfig().solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "rpc_unavailable", "Could not reach the Solana RPC. Retry shortly.");
  }
  if (res.status === 429) throw new ApiError(503, "rpc_busy", "The Solana RPC is busy. Retry in a few seconds.");
  if (!res.ok) throw new ApiError(502, "rpc_unavailable", `Solana RPC answered ${res.status}. Retry shortly.`);
  const text = await readCapped(res, RPC_MAX_RESPONSE_BYTES);
  if (text === null) throw new ApiError(502, "rpc_response_too_large", "The RPC answer was too large.");
  const body = parseJson(text) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (!body || typeof body !== "object") throw new ApiError(502, "rpc_unavailable", "Solana RPC sent an unreadable answer.");
  if (body.error) {
    const code = typeof body.error.code === "number" ? body.error.code : -32000;
    const message = typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "RPC error";
    return { jsonrpc: "2.0", id: call.id, error: { code, message } };
  }
  if (!("result" in body)) throw new ApiError(502, "rpc_unavailable", "Solana RPC sent an answer without a result.");
  return { jsonrpc: "2.0", id: call.id, result: body.result };
}

/** The body as UTF-8, or null once it passes maxBytes (the rest is not read). */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    throw new ApiError(502, "rpc_unavailable", "The Solana RPC answer was cut off. Retry shortly.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
