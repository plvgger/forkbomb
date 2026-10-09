// Browser-side calls to the site's own API. Every error comes back as ApiFailure with the server's code and copy.

export type TokenInfo = {
  ticker: string;
  mint: string | null;
  decimals: number | null;
  program: "token" | "token-2022" | null;
  burnsOpen: boolean;
  memoPrefix: string;
  cluster: "mainnet" | "devnet" | "testnet";
  creditMultiplier: string;
  maxCreditPerBurnUsd: string;
};

export type Workspace = { id: string; label: string; createdAt: string };

export type Me = {
  workspace: Workspace;
  credits: { balanceMicroUsd: number; balanceUsd: number };
  pricing: { inputPerMTokUsd: number; outputPerMTokUsd: number; model: string };
};

export type UsageRow = {
  id: string;
  createdAt: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  status: "ok" | "error" | "expired";
};
export type Usage = {
  usage: UsageRow[];
  totals: { requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number; creditedMicroUsd: number };
};

export type Created = { workspace: Workspace; apiKey: string; burnMemo: string };

export type Price = {
  priceUsd: string | null;
  twapUsd: string | null;
  sampledAt: string | null;
  /** Samples in the TWAP window (the last 15 minutes). */
  windowSamples: number;
};

export type BurnRecord = {
  signature: string;
  amountUi: string;
  usdValue: string;
  priceUsd: string;
  creditMicroUsd: number;
  status: "credited" | "review" | "already_credited";
};

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init, headers: { accept: "application/json", ...init.headers } });
  } catch {
    throw new ApiFailure(0, "network", "Couldn't reach the server. Check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  if (!res.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : `http_${res.status}`;
    const message = typeof body?.error?.message === "string" ? body.error.message : `The server answered HTTP ${res.status}.`;
    const ra = Number(res.headers.get("retry-after"));
    throw new ApiFailure(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  return body as T;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const getToken = () => call<TokenInfo>("/api/token");
export const createWorkspace = (label: string) => call<Created>("/api/workspaces", post({ label }));
export const getMe = (key: string) => call<Me>("/api/v1/me", { headers: bearer(key) });
export const getUsage = (key: string, limit = 25) => call<Usage>(`/api/v1/usage?limit=${limit}`, { headers: bearer(key) });

/** POST /api/burns/verify. 200 credited/already_credited, 202 review; errors carry burns.ts codes. */
export const verifyBurn = (signature: string) =>
  call<{ burn: BurnRecord }>("/api/burns/verify", post({ signature })).then((r) => r.burn);

export async function getPrice(): Promise<Price> {
  const body = await call<{
    latest?: { priceUsd?: string; ts?: string } | null;
    twap?: { priceUsd?: string; samples?: number } | null;
  }>("/api/price");
  return {
    priceUsd: body.latest?.priceUsd ?? null,
    twapUsd: body.twap?.priceUsd ?? null,
    sampledAt: body.latest?.ts ?? null,
    windowSamples: typeof body.twap?.samples === "number" ? body.twap.samples : 0,
  };
}

/** Keys look like "<slug>_sk_" + 32 base62 chars. */
export const looksLikeKey = (key: string) => /^[a-z0-9]+_sk_[0-9A-Za-z]{32}$/.test(key);
