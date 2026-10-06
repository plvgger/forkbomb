// Credit balances in integer micro-USD. Consumptive only: credit comes from burns, leaves as compute.
// Flow for one gateway request: reserve(max cost) -> call upstream -> settle(actual cost) refunds the rest.
// A reservation is settled or expired exactly once; usage is recorded in the same transaction.

import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { getDb, int, type Queryable } from "./db";
import { ApiError } from "./http";

export class InsufficientCreditsError extends ApiError {
  constructor(
    readonly balanceMicroUsd: number,
    readonly requiredMicroUsd: number,
  ) {
    super(
      402,
      "insufficient_credits",
      `Insufficient credits: this request needs up to $${formatMicroUsd(requiredMicroUsd)} and the workspace has $${formatMicroUsd(balanceMicroUsd)} remaining. Burn tokens to add credit.`,
    );
  }
}

export class UnknownWorkspaceError extends ApiError {
  constructor(id: string) {
    super(404, "unknown_workspace", `No workspace ${id}.`);
  }
}

/** 1234567 -> "1.234567". Exact. */
export function formatMicroUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  return `${sign}${Math.floor(abs / 1e6)}.${String(abs % 1e6).padStart(6, "0")}`;
}

function assertMicro(n: number, what: string, allowZero = false) {
  if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new RangeError(`${what} must be a ${allowZero ? "non-negative" : "positive"} safe integer, got ${n}`);
  }
}

/** Cost of a request at the configured per-1M-token prices, rounded up to the next micro-USD. */
export function costMicroUsd(inputTokens: number, outputTokens: number, pricing = getConfig().pricing): number {
  assertMicro(inputTokens, "inputTokens", true);
  assertMicro(outputTokens, "outputTokens", true);
  const scaled =
    BigInt(inputTokens) * BigInt(pricing.inputPerMTokMicroUsd) +
    BigInt(outputTokens) * BigInt(pricing.outputPerMTokMicroUsd);
  return Number((scaled + 999_999n) / 1_000_000n);
}

/**
 * Add credit inside the caller's transaction. (reason, ref) is unique, so the same burn cannot credit twice:
 * a repeat throws a unique violation and rolls the caller back. Returns the new spendable balance.
 */
export async function credit(
  q: Queryable,
  workspaceId: string,
  microUsd: number,
  reason: "burn" | "grant",
  ref: string,
): Promise<number> {
  assertMicro(microUsd, "credit");
  await q.query("INSERT INTO credit_ledger (workspace_id, delta_micro_usd, reason, ref) VALUES ($1, $2, $3, $4)", [
    workspaceId,
    microUsd,
    reason,
    ref,
  ]);
  const rows = await q.query<{ balance_micro_usd: unknown }>(
    "UPDATE workspaces SET balance_micro_usd = balance_micro_usd + $2 WHERE id = $1 RETURNING balance_micro_usd",
    [workspaceId, microUsd],
  );
  if (!rows[0]) throw new UnknownWorkspaceError(workspaceId);
  return int(rows[0].balance_micro_usd);
}

/** Spendable balance (active reservations already taken out). Throws UnknownWorkspaceError. */
export async function getBalance(workspaceId: string, q?: Queryable): Promise<number> {
  const db = q ?? (await getDb());
  const rows = await db.query<{ balance_micro_usd: unknown }>(
    "SELECT balance_micro_usd FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  if (!rows[0]) throw new UnknownWorkspaceError(workspaceId);
  return int(rows[0].balance_micro_usd);
}

export type Reservation = {
  id: string;
  workspaceId: string;
  amountMicroUsd: number;
  /** Spendable balance right after this reservation. */
  balanceMicroUsd: number;
};

/**
 * Hold up to maxMicroUsd for one request. The debit is a single conditional UPDATE, so concurrent
 * reserves can never take the balance below zero. Throws InsufficientCreditsError (402).
 */
export async function reserve(workspaceId: string, maxMicroUsd: number): Promise<Reservation> {
  assertMicro(maxMicroUsd, "maxMicroUsd");
  const db = await getDb();
  const id = `rsv_${randomUUID()}`;
  const result = await db.tx(async (q) => {
    const rows = await q.query<{ balance_micro_usd: unknown }>(
      `UPDATE workspaces SET balance_micro_usd = balance_micro_usd - $2
       WHERE id = $1 AND balance_micro_usd >= $2 RETURNING balance_micro_usd`,
      [workspaceId, maxMicroUsd],
    );
    if (!rows[0]) return null;
    await q.query("INSERT INTO reservations (id, workspace_id, amount_micro_usd) VALUES ($1, $2, $3)", [
      id,
      workspaceId,
      maxMicroUsd,
    ]);
    return int(rows[0].balance_micro_usd);
  });
  if (result === null) throw new InsufficientCreditsError(await getBalance(workspaceId, db), maxMicroUsd);
  return { id, workspaceId, amountMicroUsd: maxMicroUsd, balanceMicroUsd: result };
}

export type UsageInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** "error" when upstream failed; charge 0 for those unless tokens were really spent. */
  status?: "ok" | "error";
};

export type Settlement = {
  reservationId: string;
  workspaceId: string;
  /** What was charged: min(actual, reserved). */
  chargedMicroUsd: number;
  refundedMicroUsd: number;
  /** True when actual cost exceeded the reservation and was capped at it. */
  capped: boolean;
  balanceMicroUsd: number;
};

/**
 * Close a reservation: charge min(actualMicroUsd, reserved), refund the rest, record usage.
 * Exactly once: returns null if the reservation is unknown, already settled, or expired (already refunded).
 */
export async function settle(reservationId: string, actualMicroUsd: number, usage: UsageInput): Promise<Settlement | null> {
  assertMicro(actualMicroUsd, "actualMicroUsd", true);
  assertMicro(usage.inputTokens, "inputTokens", true);
  assertMicro(usage.outputTokens, "outputTokens", true);
  const db = await getDb();
  return db.tx(async (q) => {
    const rows = await q.query<{ workspace_id: string; amount_micro_usd: unknown }>(
      `UPDATE reservations SET status = 'settled', settled_at = now()
       WHERE id = $1 AND status = 'active' RETURNING workspace_id, amount_micro_usd`,
      [reservationId],
    );
    const row = rows[0];
    if (!row) return null;
    const reserved = int(row.amount_micro_usd);
    const charged = Math.min(actualMicroUsd, reserved);
    const refunded = reserved - charged;
    const bal = await q.query<{ balance_micro_usd: unknown }>(
      "UPDATE workspaces SET balance_micro_usd = balance_micro_usd + $2 WHERE id = $1 RETURNING balance_micro_usd",
      [row.workspace_id, refunded],
    );
    await q.query(
      `INSERT INTO usage (workspace_id, reservation_id, model, input_tokens, output_tokens, cost_micro_usd, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.workspace_id, reservationId, usage.model.slice(0, 200), usage.inputTokens, usage.outputTokens, charged, usage.status ?? "ok"],
    );
    return {
      reservationId,
      workspaceId: row.workspace_id,
      chargedMicroUsd: charged,
      refundedMicroUsd: refunded,
      capped: actualMicroUsd > reserved,
      balanceMicroUsd: int(bal[0]!.balance_micro_usd),
    };
  });
}

/**
 * Refund every active reservation created before now - olderThanMinutes, in one statement.
 * Each gets a zero-cost "expired" usage row, so a late settle() of it returns null. Returns how many expired.
 */
export async function expireStaleReservations(
  olderThanMinutes = getConfig().reservationTtlMinutes,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const db = await getDb();
  const rows = await db.query<{ n: unknown }>(
    `WITH expired AS (
       UPDATE reservations SET status = 'expired', settled_at = now()
       WHERE status = 'active' AND created_at < $1
       RETURNING id, workspace_id, amount_micro_usd
     ), logged AS (
       INSERT INTO usage (workspace_id, reservation_id, model, input_tokens, output_tokens, cost_micro_usd, status)
       SELECT workspace_id, id, '', 0, 0, 0, 'expired' FROM expired
     ), refunded AS (
       UPDATE workspaces w SET balance_micro_usd = w.balance_micro_usd + t.total
       FROM (SELECT workspace_id, SUM(amount_micro_usd) AS total FROM expired GROUP BY workspace_id) t
       WHERE w.id = t.workspace_id
     )
     SELECT COUNT(*) AS n FROM expired`,
    [cutoff.toISOString()],
  );
  return int(rows[0]?.n ?? 0);
}
