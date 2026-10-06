// What the /app burn flow needs to know about the token: mint, decimals and which token program owns it.
// Read once from the configured RPC and cached for 5 minutes per (mint, RPC). Failures are not cached.

import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { BRAND, getConfig } from "@/lib/server/config";
import { formatMicroUsd } from "@/lib/server/credits";

export type TokenProgramKind = "token" | "token-2022";
export type Cluster = "mainnet" | "devnet" | "testnet";

export type TokenInfo = {
  ticker: string;
  mint: string | null;
  decimals: number | null;
  program: TokenProgramKind | null;
  /** True only when the mint is set and was read on chain: the client can build a burn. */
  burnsOpen: boolean;
  /** Burns carry the memo "<memoPrefix><workspaceId>". burns.ts verifies exactly this prefix. */
  memoPrefix: string;
  /** Which Solana cluster the configured RPC serves, so the wallet signs for the same chain. */
  cluster: Cluster;
  /** Credit per USD burned, as a decimal string ("1" = $1 of credit per $1 burned). */
  creditMultiplier: string;
  /** A single burn worth more than this (USD) is held for manual review instead of credited. */
  maxCreditPerBurnUsd: string;
};

export const TOKEN_CACHE_MS = 5 * 60_000;
const RPC_TIMEOUT_MS = 8_000;

const PROGRAMS: Record<string, TokenProgramKind> = {
  [TOKEN_PROGRAM_ADDRESS]: "token",
  [TOKEN_2022_PROGRAM_ADDRESS]: "token-2022",
};

let cache: { key: string; at: number; info: TokenInfo } | null = null;

/** Tests: forget the cached mint. */
export function resetTokenCache(): void {
  cache = null;
}

/** Best guess from the RPC URL. Anything not obviously devnet or testnet is mainnet. */
export function clusterOf(rpcUrl: string): Cluster {
  const host = (() => {
    try {
      return new URL(rpcUrl).host;
    } catch {
      return "";
    }
  })();
  if (/devnet/i.test(host)) return "devnet";
  if (/testnet/i.test(host)) return "testnet";
  return "mainnet";
}

type MintAccount = {
  value: { owner?: unknown; data?: { parsed?: { type?: unknown; info?: { decimals?: unknown } } } } | null;
};

/** owner program + decimals of a mint, or null when the RPC can't tell us. */
async function readMint(rpcUrl: string, mint: string): Promise<{ program: TokenProgramKind; decimals: number } | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { result?: MintAccount } | null;
    const value = body?.result?.value;
    const program = typeof value?.owner === "string" ? PROGRAMS[value.owner] : undefined;
    const parsed = value?.data?.parsed;
    const decimals = parsed?.info?.decimals;
    if (!program || parsed?.type !== "mint" || typeof decimals !== "number" || !Number.isInteger(decimals)) return null;
    if (decimals < 0 || decimals > 18) return null;
    return { program, decimals };
  } catch {
    return null;
  }
}

export async function tokenInfo(now: number = Date.now()): Promise<TokenInfo> {
  const cfg = getConfig();
  const base: TokenInfo = {
    ticker: BRAND.ticker,
    mint: null,
    decimals: null,
    program: null,
    burnsOpen: false,
    memoPrefix: `${BRAND.slug}:`,
    cluster: clusterOf(cfg.solanaRpcUrl),
    creditMultiplier: formatPpm(cfg.creditMultiplierPpm),
    maxCreditPerBurnUsd: trimZeros(formatMicroUsd(cfg.maxCreditPerBurnMicroUsd)),
  };
  if (!cfg.tokenMint) return base;

  const key = `${cfg.tokenMint}|${cfg.solanaRpcUrl}`;
  if (cache && cache.key === key && now - cache.at < TOKEN_CACHE_MS) return cache.info;

  const mint = await readMint(cfg.solanaRpcUrl, cfg.tokenMint);
  const info: TokenInfo = mint
    ? { ...base, mint: cfg.tokenMint, decimals: mint.decimals, program: mint.program, burnsOpen: true }
    : { ...base, mint: cfg.tokenMint };
  if (mint) cache = { key, at: now, info };
  return info;
}

/** "5000.000000" -> "5000", "1.500000" -> "1.5". Input always has a fraction (formatMicroUsd). */
const trimZeros = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
const formatPpm = (ppm: bigint) => trimZeros(formatMicroUsd(Number(ppm)));
