// Solana reads through the site's /api/rpc proxy (allowlisted methods only).

import { ApiFailure } from "./api";

let nextId = 1;

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/rpc", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
  } catch {
    throw new ApiFailure(0, "network", "Couldn't reach the server. Check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as {
    result?: T;
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (!res.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : `http_${res.status}`;
    const message = typeof body?.error?.message === "string" ? body.error.message : `RPC proxy answered HTTP ${res.status}.`;
    throw new ApiFailure(res.status, code, message);
  }
  if (!body || body.error || !("result" in body)) {
    const message = typeof body?.error?.message === "string" ? body.error.message : "The Solana RPC returned an error.";
    throw new ApiFailure(502, "rpc_error", message);
  }
  return body.result as T;
}

export async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const r = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
}

export async function solBalanceLamports(owner: string): Promise<bigint> {
  const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

type ParsedTokenAccount = {
  pubkey: string;
  account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } };
};

/** Raw balance of `ata`, plus what the owner holds of this mint in any other token account. */
export async function tokenBalances(
  owner: string,
  mint: string,
  ata: string,
): Promise<{ ata: bigint; ataExists: boolean; elsewhere: bigint }> {
  const r = await rpc<{ value: ParsedTokenAccount[] }>("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  let ataBal = 0n;
  let ataExists = false;
  let elsewhere = 0n;
  for (const acc of r.value ?? []) {
    const raw = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
    const amount = typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    if (acc.pubkey === ata) {
      ataExists = true;
      ataBal = amount;
    } else {
      elsewhere += amount;
    }
  }
  return { ata: ataBal, ataExists, elsewhere };
}
