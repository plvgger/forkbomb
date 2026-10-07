// Read-only usage view for one workspace: the latest settled requests plus all-time totals.
// The usage table keeps the upstream model for operators; clients only ever see the hosted model name.

import { getDb, int, iso } from "@/lib/server/db";
import { hostedModel } from "@/lib/server/gateway/chat";

export type UsageRow = {
  id: string;
  createdAt: string;
  /** Always the hosted model name the gateway shows ("forkbomb-hosted"), never the upstream one. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  status: "ok" | "error" | "expired";
};

export type UsageTotals = {
  /** Settled requests (expired reservations are not requests and are left out). */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  /** Everything ever credited to the workspace (burns and grants). */
  creditedMicroUsd: number;
};

export async function workspaceUsage(workspaceId: string, limit: number): Promise<{ usage: UsageRow[]; totals: UsageTotals }> {
  const db = await getDb();
  const rows = await db.query<{
    id: unknown;
    created_at: unknown;
    input_tokens: unknown;
    output_tokens: unknown;
    cost_micro_usd: unknown;
    status: UsageRow["status"];
  }>(
    `SELECT id::text AS id, created_at, input_tokens, output_tokens, cost_micro_usd, status
     FROM usage WHERE workspace_id = $1 AND status <> 'expired'
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [workspaceId, limit],
  );
  const [t] = await db.query<{ requests: unknown; input: unknown; output: unknown; cost: unknown }>(
    `SELECT COUNT(*)::text AS requests, COALESCE(SUM(input_tokens), 0)::text AS input,
       COALESCE(SUM(output_tokens), 0)::text AS output, COALESCE(SUM(cost_micro_usd), 0)::text AS cost
     FROM usage WHERE workspace_id = $1 AND status <> 'expired'`,
    [workspaceId],
  );
  const [c] = await db.query<{ credited: unknown }>(
    "SELECT COALESCE(SUM(delta_micro_usd), 0)::text AS credited FROM credit_ledger WHERE workspace_id = $1",
    [workspaceId],
  );
  return {
    usage: rows.map((r) => ({
      id: String(r.id),
      createdAt: iso(r.created_at),
      model: hostedModel(),
      inputTokens: int(r.input_tokens),
      outputTokens: int(r.output_tokens),
      costMicroUsd: int(r.cost_micro_usd),
      status: r.status,
    })),
    totals: {
      requests: int(t!.requests),
      inputTokens: int(t!.input),
      outputTokens: int(t!.output),
      costMicroUsd: int(t!.cost),
      creditedMicroUsd: int(c!.credited),
    },
  };
}
