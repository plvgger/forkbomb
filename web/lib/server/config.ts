// One place for every server-side setting of the burn-for-compute loop.
// Everything reads from env with a safe default, and is read on each call so tests can change env.
// Rename the product here: BRAND is the only place the name, slug and ticker live on the server.

export const BRAND = {
  name: process.env.BRAND_NAME || "Forkbomb",
  /**
   * Lowercase, [a-z0-9]. Prefixes API keys ("<slug>_sk_...") and burn memos ("<slug>:<workspaceId>").
   * Not an env setting: the static pages print the memo from app/config.ts TOKEN_MEMO_PREFIX, which a test pins to this.
   */
  slug: "forkbomb",
  ticker: process.env.BRAND_TICKER || "FORKBOMB",
} as const;

export const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/** Fixed pepper used outside production when KEY_PEPPER is unset. Never valid in production. */
export const DEV_KEY_PEPPER = "dev-only-pepper-do-not-use-in-production";

export type Config = {
  /** SPL mint of the token. Empty until launch: burns and price sampling are disabled. */
  tokenMint: string;
  /** Burn verification and the token info read. */
  solanaRpcUrl: string;
  /** What the public /api/rpc proxy forwards to. Defaults to solanaRpcUrl; a separate key keeps abuse of the proxy off verification's quota. */
  proxyRpcUrl: string;
  keyPepper: string;
  cronSecret: string;
  /** Operator secret for POST /api/admin/grant. Under 32 characters disables the route. */
  adminSecret: string;
  /** Largest single operator grant, micro-USD. */
  maxGrantMicroUsd: number;
  databaseUrl: string;
  pricing: {
    /** USD per 1M input tokens, as integer micro-USD (0.60 USD -> 600_000). */
    inputPerMTokMicroUsd: number;
    outputPerMTokMicroUsd: number;
  };
  /** Credit per USD burned, in parts per million (1.0 -> 1_000_000). */
  creditMultiplierPpm: bigint;
  /** A single burn worth more than this is held for manual review instead of credited. Micro-USD. */
  maxCreditPerBurnMicroUsd: number;
  upstream: {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** How requests travel: plain OpenAI HTTP, or RunPod's job queue, whose jobs can be cancelled. */
    transport: UpstreamTransport;
    /**
     * Operator-set fields added to every upstream body (UPSTREAM_EXTRA_BODY, a JSON object), e.g.
     * {"chat_template_kwargs":{"enable_thinking":false}}. Clients can't send these fields themselves.
     */
    extraBody: Record<string, unknown>;
  };
  /** Unsettled reservations older than this are refunded by the cron. */
  reservationTtlMinutes: number;
  limits: {
    workspaceCreatePerHour: number;
    verifyPerMinute: number;
    gatewayPerMinute: number;
    rpcPerMinute: number;
    /** All /api/rpc calls together, across every IP. */
    rpcGlobalPerMinute: number;
  };
};

export type UpstreamTransport = "openai" | "runpod";

/** RunPod serverless's OpenAI route. It keeps generating after the client hangs up; its job queue can cancel. */
const RUNPOD_OPENAI_URL = /^https:\/\/api\.runpod\.ai\/v2\/[\w-]+\/openai\/v1$/i;

/** UPSTREAM_TRANSPORT=openai|runpod wins; unset (or anything else) picks the queue for RunPod's OpenAI URL. */
export function upstreamTransport(override: string | undefined, baseUrl: string): UpstreamTransport {
  const o = (override ?? "").trim().toLowerCase();
  if (o === "openai" || o === "runpod") return o;
  return RUNPOD_OPENAI_URL.test(baseUrl) ? "runpod" : "openai";
}

export const isProduction = () => process.env.NODE_ENV === "production";

/** True while `next build` evaluates modules. Secrets are not required then. */
const isBuildPhase = () => process.env.NEXT_PHASE === "phase-production-build";

export function getConfig(): Config {
  const env = process.env;
  const upstreamUrl = (env.UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  const solanaRpcUrl = (env.SOLANA_RPC_URL || "").trim() || PUBLIC_MAINNET_RPC;
  return {
    tokenMint: (env.TOKEN_MINT || "").trim(),
    solanaRpcUrl,
    proxyRpcUrl: (env.SOLANA_PROXY_RPC_URL || "").trim() || solanaRpcUrl,
    keyPepper: env.KEY_PEPPER || "",
    cronSecret: env.CRON_SECRET || "",
    adminSecret: env.ADMIN_SECRET || "",
    maxGrantMicroUsd: usdToMicro(env.MAX_GRANT_USD, 100_000_000),
    databaseUrl: env.DATABASE_URL || "",
    pricing: {
      inputPerMTokMicroUsd: usdToMicro(env.PRICE_INPUT_PER_MTOK_USD, 600_000),
      outputPerMTokMicroUsd: usdToMicro(env.PRICE_OUTPUT_PER_MTOK_USD, 2_400_000),
    },
    creditMultiplierPpm: BigInt(usdToMicro(env.CREDIT_MULTIPLIER, 1_000_000)),
    maxCreditPerBurnMicroUsd: usdToMicro(env.MAX_CREDIT_PER_BURN_USD, 5_000_000_000),
    upstream: {
      baseUrl: upstreamUrl,
      apiKey: env.UPSTREAM_API_KEY || "",
      model: (env.UPSTREAM_MODEL || "").trim() || `${BRAND.slug}-coder`,
      transport: upstreamTransport(env.UPSTREAM_TRANSPORT, upstreamUrl),
      extraBody: jsonObject(env.UPSTREAM_EXTRA_BODY, "UPSTREAM_EXTRA_BODY"),
    },
    reservationTtlMinutes: positiveInt(env.RESERVATION_TTL_MINUTES, 15),
    limits: {
      workspaceCreatePerHour: positiveInt(env.RATE_WORKSPACE_CREATE_PER_HOUR, 5),
      verifyPerMinute: positiveInt(env.RATE_VERIFY_PER_MINUTE, 30),
      gatewayPerMinute: positiveInt(env.RATE_GATEWAY_PER_MINUTE, 120),
      rpcPerMinute: positiveInt(env.RATE_RPC_PER_MINUTE, 120),
      rpcGlobalPerMinute: positiveInt(env.RATE_RPC_GLOBAL_PER_MINUTE, 1200),
    },
  };
}

/** The HMAC pepper for API keys and IP hashes. Throws in production when unset. */
export function getKeyPepper(): string {
  const pepper = getConfig().keyPepper;
  if (pepper) return pepper;
  if (isProduction() && !isBuildPhase()) throw new Error("KEY_PEPPER is required in production");
  return DEV_KEY_PEPPER;
}

/** "0.60" -> 600000. Accepts up to 6 decimals, no exponent. Falls back on anything else. */
export function usdToMicro(raw: string | undefined, fallback: number): number {
  const s = (raw ?? "").trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return fallback;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/** A JSON object from env, or {} (logged) when it is missing or not an object. */
export function jsonObject(raw: string | undefined, name: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  console.error(`[config] ${name} is not a JSON object; ignoring it`);
  return {};
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
