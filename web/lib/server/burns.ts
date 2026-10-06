// Burn verification: read a finalized transaction back from Solana, check it burned our mint and carries
// the memo "<slug>:<workspaceId>", price it at burn time, and credit the workspace once.
// The burns primary key (signature) is the idempotency key, so concurrent or replayed verifies credit once.

import { BRAND, getConfig } from "./config";
import { credit } from "./credits";
import { dec, getDb, int, iso, type Queryable } from "./db";
import { formatScaled, PRICE_SCALE } from "./decimal";
import { ApiError } from "./http";
import { burnPrice, priceToString } from "./price";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const MEMO_V2_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
const MEMO_PROGRAMS = new Set([MEMO_V1_PROGRAM, MEMO_V2_PROGRAM]);

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export type BurnErrorCode =
  | "invalid_signature"
  | "not_configured"
  | "not_found"
  | "not_finalized"
  | "failed_tx"
  | "wrong_mint"
  | "no_burn"
  | "bad_memo"
  | "balance_mismatch"
  | "unknown_workspace"
  | "too_old_for_price"
  | "price_unavailable"
  | "rpc_error";

const STATUS: Record<BurnErrorCode, number> = {
  invalid_signature: 400,
  not_configured: 503,
  not_found: 404,
  not_finalized: 409,
  failed_tx: 422,
  wrong_mint: 422,
  no_burn: 422,
  bad_memo: 422,
  balance_mismatch: 422,
  unknown_workspace: 422,
  too_old_for_price: 422,
  price_unavailable: 503,
  rpc_error: 502,
};

export class BurnError extends ApiError {
  constructor(
    readonly burnCode: BurnErrorCode,
    message: string,
  ) {
    super(STATUS[burnCode], burnCode, message);
  }
}

/** credited: added to the balance. review: over the per-burn cap, held for a human. already_credited: replay. */
export type BurnStatus = "credited" | "review" | "already_credited";

export type BurnRecord = {
  signature: string;
  workspaceId: string;
  owner: string;
  mint: string;
  amountRaw: string;
  decimals: number;
  amountUi: string;
  priceUsd: string;
  usdValue: string;
  creditMicroUsd: number;
  slot: number;
  blockTime: string;
  verifiedAt: string;
  status: BurnStatus;
};

// ---- Solana JSON-RPC (jsonParsed) shapes, only the fields we read ----

export type ParsedInstruction = {
  programId: string;
  program?: string;
  parsed?: unknown;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
};
export type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
};
export type ParsedTransaction = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ({ pubkey: string } | string)[]; instructions: ParsedInstruction[] };
  };
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(getConfig().solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BurnError("rpc_error", "Could not reach the Solana RPC. Retry shortly.");
  }
  if (!res.ok) throw new BurnError("rpc_error", `Solana RPC answered ${res.status}. Retry shortly.`);
  const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!body || body.error || !("result" in body)) throw new BurnError("rpc_error", "Solana RPC returned an error. Retry shortly.");
  return body.result as T;
}

/** The finalized transaction, or a BurnError: not_found, not_finalized or failed_tx. */
export async function fetchFinalizedTransaction(signature: string): Promise<ParsedTransaction> {
  const tx = await rpc<ParsedTransaction | null>("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  if (tx) return tx;
  const status = await rpc<{ value: ({ confirmationStatus?: string | null; err?: unknown } | null)[] }>(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  const s = status?.value?.[0];
  if (s?.err) throw new BurnError("failed_tx", "The transaction failed on chain. Nothing was burned.");
  if (s) throw new BurnError("not_finalized", "The transaction is not finalized yet. Retry in about 30 seconds.");
  throw new BurnError("not_found", "No transaction with this signature on Solana mainnet.");
}

export type ParsedBurn = {
  workspaceId: string;
  owner: string;
  mint: string;
  amountRaw: bigint;
  decimals: number;
  slot: number;
  blockTime: Date;
};

type Info = Record<string, unknown>;
const parsedOf = (ix: ParsedInstruction): { type?: unknown; info?: Info } | null =>
  ix.parsed && typeof ix.parsed === "object" ? (ix.parsed as { type?: unknown; info?: Info }) : null;

/** Top-level and inner (CPI) instructions, in order. */
export function allInstructions(tx: ParsedTransaction): ParsedInstruction[] {
  const out: ParsedInstruction[] = [];
  const inner = tx.meta?.innerInstructions ?? [];
  tx.transaction.message.instructions.forEach((ix, i) => {
    out.push(ix);
    for (const group of inner) if (group.index === i) out.push(...group.instructions);
  });
  return out;
}

/**
 * Checks a fetched transaction against the burn rules and extracts what to credit. Pure: no I/O.
 * Throws BurnError: failed_tx, not_finalized, no_burn, wrong_mint, balance_mismatch, bad_memo.
 */
export function parseBurnTransaction(tx: ParsedTransaction, mint: string, slug = BRAND.slug): ParsedBurn {
  if (!tx.meta || tx.meta.err !== null) throw new BurnError("failed_tx", "The transaction failed on chain. Nothing was burned.");
  if (tx.blockTime === null || tx.blockTime === undefined) throw new BurnError("not_finalized", "The transaction has no block time yet.");

  const ixs = allInstructions(tx);
  const burns = ixs.filter((ix) => {
    const p = parsedOf(ix);
    return TOKEN_PROGRAMS.has(ix.programId) && (p?.type === "burn" || p?.type === "burnChecked");
  });
  if (!burns.length) throw new BurnError("no_burn", "This transaction does not burn any token.");
  const ours = burns.filter((ix) => parsedOf(ix)?.info?.mint === mint);
  if (!ours.length) throw new BurnError("wrong_mint", `This transaction burns a different token, not ${BRAND.ticker}.`);

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const balance = (list: TokenBalance[] | null | undefined, account: string) =>
    (list ?? []).find((b) => keys[b.accountIndex] === account && b.mint === mint);

  let amountRaw = 0n;
  let decimals: number | null = null;
  let owner = "";
  const perAccount = new Map<string, bigint>();
  for (const ix of ours) {
    const p = parsedOf(ix)!;
    const info = p.info!;
    const account = String(info.account ?? "");
    const tokenAmount = info.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
    const raw = p.type === "burnChecked" ? tokenAmount?.amount : info.amount;
    if (typeof raw !== "string" || !/^\d{1,40}$/.test(raw)) throw new BurnError("no_burn", "A burn instruction has no readable amount.");
    const pre = balance(tx.meta.preTokenBalances, account);
    if (!pre) throw new BurnError("balance_mismatch", "The burned account has no balance record in this transaction.");
    const d = pre.uiTokenAmount.decimals;
    if (p.type === "burnChecked" && tokenAmount?.decimals !== d) {
      throw new BurnError("balance_mismatch", "Burn decimals do not match the token account.");
    }
    if (decimals !== null && decimals !== d) throw new BurnError("balance_mismatch", "Burns disagree on decimals.");
    decimals = d;
    owner ||= String(info.authority ?? info.multisigAuthority ?? "");
    amountRaw += BigInt(raw);
    perAccount.set(account, (perAccount.get(account) ?? 0n) + BigInt(raw));
  }
  // Cross-check: each burned account's balance fell by exactly what its burns say (closed account = 0 after).
  for (const [account, burned] of perAccount) {
    const pre = BigInt(balance(tx.meta.preTokenBalances, account)!.uiTokenAmount.amount);
    const post = BigInt(balance(tx.meta.postTokenBalances, account)?.uiTokenAmount.amount ?? "0");
    if (pre - post !== burned) {
      throw new BurnError("balance_mismatch", "The burn amount does not match the token account's balance change.");
    }
  }
  if (amountRaw <= 0n) throw new BurnError("no_burn", "This transaction burns zero tokens.");

  const memos = ixs
    .filter((ix) => MEMO_PROGRAMS.has(ix.programId))
    .map((ix) => (typeof ix.parsed === "string" ? ix.parsed.trim() : null));
  const prefix = `${slug}:`;
  const mine = memos.filter((m) => m !== null && m.startsWith(prefix)) as string[];
  if (mine.length !== 1) {
    throw new BurnError(
      "bad_memo",
      mine.length ? "The transaction has more than one memo for this site." : `The burn needs a memo "${prefix}<workspaceId>".`,
    );
  }
  const m = new RegExp(`^${escapeRe(prefix)}(ws_[A-Za-z0-9]{16,32})$`).exec(mine[0]!);
  if (!m) throw new BurnError("bad_memo", `The memo must be exactly "${prefix}<workspaceId>" with nothing else.`);

  return {
    workspaceId: m[1]!,
    owner,
    mint,
    amountRaw,
    decimals: decimals!,
    slot: tx.slot,
    blockTime: new Date(tx.blockTime * 1000),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** usd (atto) = raw * price / 10^decimals; credit (micro) = usd * multiplier, floored. Integer only. */
export function valueBurn(amountRaw: bigint, decimals: number, priceAtto: bigint, multiplierPpm = getConfig().creditMultiplierPpm) {
  const usdAtto = (amountRaw * priceAtto) / 10n ** BigInt(decimals);
  const creditMicro = (usdAtto * multiplierPpm) / 10n ** BigInt(PRICE_SCALE); // atto * ppm / 1e18 = micro
  return { usdAtto, usdValue: formatScaled(usdAtto / 10n ** 12n, 6), creditMicroUsd: Number(creditMicro) };
}

type BurnRow = {
  signature: string;
  workspace_id: string;
  owner: string;
  mint: string;
  amount_raw: unknown;
  decimals: unknown;
  amount_ui: unknown;
  price_usd: unknown;
  usd_value: unknown;
  credit_micro_usd: unknown;
  status: "credited" | "review";
  slot: unknown;
  block_time: unknown;
  verified_at: unknown;
};

const BURN_COLUMNS = `signature, workspace_id, owner, mint, amount_raw::text AS amount_raw, decimals, amount_ui::text AS amount_ui,
  price_usd::text AS price_usd, usd_value::text AS usd_value, credit_micro_usd, status, slot, block_time, verified_at`;

function toRecord(r: BurnRow, status: BurnStatus = r.status): BurnRecord {
  return {
    signature: r.signature,
    workspaceId: r.workspace_id,
    owner: r.owner,
    mint: r.mint,
    amountRaw: dec(r.amount_raw),
    decimals: int(r.decimals),
    amountUi: dec(r.amount_ui),
    priceUsd: dec(r.price_usd),
    usdValue: dec(r.usd_value),
    creditMicroUsd: int(r.credit_micro_usd),
    slot: int(r.slot),
    blockTime: iso(r.block_time),
    verifiedAt: iso(r.verified_at),
    status,
  };
}

async function findBurn(q: Queryable, signature: string): Promise<BurnRecord | null> {
  const rows = await q.query<BurnRow>(`SELECT ${BURN_COLUMNS} FROM burns WHERE signature = $1`, [signature]);
  return rows[0] ? toRecord(rows[0], rows[0].status === "credited" ? "already_credited" : rows[0].status) : null;
}

/**
 * Verify a burn signature and credit its workspace. Idempotent: a signature already recorded returns
 * that record with status "already_credited" (or "review"). Burns over MAX_CREDIT_PER_BURN_USD are recorded
 * with status "review" and credit nothing until a human looks. Throws BurnError.
 */
export async function verifyBurn(signature: string, opts: { now?: Date } = {}): Promise<BurnRecord> {
  const sig = typeof signature === "string" ? signature.trim() : "";
  if (!SIGNATURE_RE.test(sig)) throw new BurnError("invalid_signature", "signature must be a base58 Solana transaction signature.");
  const cfg = getConfig();
  if (!cfg.tokenMint) throw new BurnError("not_configured", `${BRAND.ticker} has not launched yet. Burns open at launch.`);
  const db = await getDb();

  const seen = await findBurn(db, sig);
  if (seen) return seen;

  const tx = await fetchFinalizedTransaction(sig);
  if (tx.transaction.signatures[0] !== sig) throw new BurnError("not_found", "The RPC returned a different transaction.");
  const burn = parseBurnTransaction(tx, cfg.tokenMint);

  const ws = await db.query("SELECT 1 FROM workspaces WHERE id = $1", [burn.workspaceId]);
  if (!ws.length) throw new BurnError("unknown_workspace", `The memo names workspace ${burn.workspaceId}, which does not exist.`);

  const price = await burnPrice(burn.blockTime, opts.now ?? new Date(), cfg.tokenMint);
  if (!price.ok) throw new BurnError(price.code, price.message);
  const { usdValue, creditMicroUsd } = valueBurn(burn.amountRaw, burn.decimals, price.priceAtto, cfg.creditMultiplierPpm);
  const status = creditMicroUsd > cfg.maxCreditPerBurnMicroUsd ? "review" : "credited";

  return db.tx(async (q) => {
    const inserted = await q.query<BurnRow>(
      `INSERT INTO burns (signature, workspace_id, owner, mint, amount_raw, decimals, amount_ui, price_usd, usd_value,
         credit_micro_usd, status, slot, block_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (signature) DO NOTHING
       RETURNING ${BURN_COLUMNS}`,
      [
        sig,
        burn.workspaceId,
        burn.owner,
        burn.mint,
        burn.amountRaw.toString(),
        burn.decimals,
        formatScaled(burn.amountRaw, burn.decimals),
        priceToString(price.priceAtto),
        usdValue,
        creditMicroUsd,
        status,
        burn.slot,
        burn.blockTime.toISOString(),
      ],
    );
    // Lost a race with a concurrent verify of the same signature: theirs credited, ours does nothing.
    if (!inserted[0]) return (await findBurn(q, sig))!;
    if (status === "credited" && creditMicroUsd > 0) await credit(q, burn.workspaceId, creditMicroUsd, "burn", sig);
    return toRecord(inserted[0]);
  });
}

export type LedgerPage = {
  burns: Omit<BurnRecord, "workspaceId" | "amountRaw" | "verifiedAt">[];
  nextCursor: string | null;
  totals: { burnedUi: string; burnedUsd: string; burns: number; creditedMicroUsd: number };
};

const encodeCursor = (blockTime: string, signature: string) =>
  Buffer.from(JSON.stringify([blockTime, signature])).toString("base64url");

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[1] === "string" && !Number.isNaN(Date.parse(String(v[0])))) {
      return [new Date(String(v[0])).toISOString(), v[1]];
    }
  } catch {}
  throw new ApiError(400, "invalid_cursor", "cursor is not valid. Use nextCursor from the previous page.");
}

/** Public ledger, newest burn first. Workspace ids are left out. */
export async function listLedger(opts: { cursor?: string | null; limit?: number } = {}): Promise<LedgerPage> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 100);
  const db = await getDb();
  const params: unknown[] = [limit + 1];
  let where = "";
  if (opts.cursor) {
    const [bt, sig] = decodeCursor(opts.cursor);
    params.push(bt, sig);
    where = "WHERE (block_time, signature) < ($2::timestamptz, $3)";
  }
  const rows = await db.query<BurnRow>(
    `SELECT ${BURN_COLUMNS} FROM burns ${where} ORDER BY block_time DESC, signature DESC LIMIT $1`,
    params,
  );
  const page = rows.slice(0, limit).map((r) => {
    const { workspaceId: _w, amountRaw: _a, verifiedAt: _v, ...pub } = toRecord(r);
    return pub;
  });
  const last = rows.length > limit ? page[page.length - 1] : undefined;
  const t = await db.query<{ ui: unknown; usd: unknown; n: unknown; credited: unknown }>(
    `SELECT COALESCE(SUM(amount_ui), 0)::text AS ui, COALESCE(SUM(usd_value), 0)::text AS usd, COUNT(*) AS n,
       COALESCE(SUM(credit_micro_usd) FILTER (WHERE status = 'credited'), 0)::text AS credited
     FROM burns`,
  );
  return {
    burns: page,
    nextCursor: last ? encodeCursor(last.blockTime, last.signature) : null,
    totals: { burnedUi: dec(t[0]!.ui), burnedUsd: dec(t[0]!.usd), burns: int(t[0]!.n), creditedMicroUsd: int(t[0]!.credited) },
  };
}
