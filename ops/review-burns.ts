// Operator tool for burns held for review: the only way to pay one out.
//
//   cd ops && DATABASE_URL=<production Neon URL> npm run review -- list
//   cd ops && DATABASE_URL=<production Neon URL> npm run review -- approve <signature>         (dry run)
//   cd ops && DATABASE_URL=<production Neon URL> npm run review -- approve <signature> --yes   (credits it)
//
// verifyBurn (../web/lib/server/burns.ts) records a burn worth more than MAX_CREDIT_PER_BURN_USD (default $5000)
// with status 'review' and credits nothing. `approve` does in one transaction what verifyBurn does for a burn under
// the cap: it flips the row from 'review' to 'credited' and credits the workspace the credit_micro_usd recorded at
// verification (the burn-time price, never a new one), as credit_ledger reason 'burn', ref <signature>.
// MAX_GRANT_USD does not apply: this is the burn's own credit, not an operator grant.
// After it, the dApp's re-verify answers "already credited", /burns shows the row credited and the ledger's
// credited total includes it.
//
// Exactly once: the UPDATE only matches a row still in 'review', and (reason, ref) is unique in credit_ledger,
// so a second or concurrent approve credits nothing. Without --yes nothing is written.
// Do not also pay the burn with POST /api/admin/grant: that would pay it twice. The dry run lists the workspace's
// earlier operator grants so a burn already paid by hand is caught before approving.
// To refuse a review burn, leave it in 'review': nothing is credited and the user keeps seeing "held for review".
//
// DATABASE_URL is required. Without it the server code would open an empty in-memory database, and `list` would
// say there is nothing to review. Only the host is printed, never the URL.
// Exit codes: 0 done, 1 refused (unknown signature, not in review, bad input), 2 usage.

import { pathToFileURL } from "node:url";
import { credit, formatMicroUsd } from "../web/lib/server/credits";
import { dec, int, iso, openNeon, type Db, type Queryable } from "../web/lib/server/db";

/** Same shape the verifier accepts (burns.ts SIGNATURE_RE): base58, 64-90 characters. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export type ReviewBurn = {
  signature: string;
  workspaceId: string;
  owner: string;
  mint: string;
  amountUi: string;
  priceUsd: string;
  usdValue: string;
  creditMicroUsd: number;
  status: "credited" | "review";
  blockTime: string;
  verifiedAt: string;
};

type Row = {
  signature: string;
  workspace_id: string;
  owner: string;
  mint: string;
  amount_ui: unknown;
  price_usd: unknown;
  usd_value: unknown;
  credit_micro_usd: unknown;
  status: "credited" | "review";
  block_time: unknown;
  verified_at: unknown;
};

const COLUMNS = `signature, workspace_id, owner, mint, amount_ui::text AS amount_ui, price_usd::text AS price_usd,
  usd_value::text AS usd_value, credit_micro_usd, status, block_time, verified_at`;

const toBurn = (r: Row): ReviewBurn => ({
  signature: r.signature,
  workspaceId: r.workspace_id,
  owner: r.owner,
  mint: r.mint,
  amountUi: dec(r.amount_ui),
  priceUsd: dec(r.price_usd),
  usdValue: dec(r.usd_value),
  creditMicroUsd: int(r.credit_micro_usd),
  status: r.status,
  blockTime: iso(r.block_time),
  verifiedAt: iso(r.verified_at),
});

/** Every burn waiting for a person, oldest first. */
export async function listReviewBurns(q: Queryable): Promise<ReviewBurn[]> {
  const rows = await q.query<Row>(`SELECT ${COLUMNS} FROM burns WHERE status = 'review' ORDER BY block_time, signature`);
  return rows.map(toBurn);
}

export type Grant = { ref: string; microUsd: number; at: string };

export type ApprovalPlan =
  | { ok: false; reason: "invalid_signature" | "not_found" | "not_in_review"; burn?: ReviewBurn }
  | { ok: true; burn: ReviewBurn; balanceMicroUsd: number; grants: Grant[] };

/** What approve would do, read only: the burn, the workspace balance and its earlier operator grants. */
export async function planApproval(q: Queryable, signature: string): Promise<ApprovalPlan> {
  const sig = signature.trim();
  if (!SIGNATURE_RE.test(sig)) return { ok: false, reason: "invalid_signature" };
  const rows = await q.query<Row>(`SELECT ${COLUMNS} FROM burns WHERE signature = $1`, [sig]);
  if (!rows[0]) return { ok: false, reason: "not_found" };
  const burn = toBurn(rows[0]);
  if (burn.status !== "review") return { ok: false, reason: "not_in_review", burn };
  const bal = await q.query<{ balance_micro_usd: unknown }>("SELECT balance_micro_usd FROM workspaces WHERE id = $1", [burn.workspaceId]);
  const grants = await q.query<{ ref: string; delta_micro_usd: unknown; created_at: unknown }>(
    "SELECT ref, delta_micro_usd, created_at FROM credit_ledger WHERE workspace_id = $1 AND reason = 'grant' ORDER BY created_at",
    [burn.workspaceId],
  );
  return {
    ok: true,
    burn,
    balanceMicroUsd: int(bal[0]!.balance_micro_usd),
    grants: grants.map((g) => ({ ref: g.ref, microUsd: int(g.delta_micro_usd), at: iso(g.created_at) })),
  };
}

export type Approval =
  | { ok: false; reason: "invalid_signature" | "not_found" | "not_in_review" }
  | { ok: true; signature: string; workspaceId: string; creditMicroUsd: number; balanceMicroUsd: number };

/**
 * Release one review burn: status 'review' -> 'credited' and its recorded credit added to the workspace, in one
 * transaction. A burn that is unknown or no longer in review changes nothing.
 */
export async function approveReviewBurn(db: Db, signature: string): Promise<Approval> {
  const sig = signature.trim();
  if (!SIGNATURE_RE.test(sig)) return { ok: false, reason: "invalid_signature" };
  const done = await db.tx(async (q) => {
    const rows = await q.query<{ workspace_id: string; credit_micro_usd: unknown }>(
      "UPDATE burns SET status = 'credited' WHERE signature = $1 AND status = 'review' RETURNING workspace_id, credit_micro_usd",
      [sig],
    );
    const row = rows[0];
    if (!row) return null;
    // A review burn is worth more than the cap, so its credit is always positive (credit() refuses 0 and rolls back).
    const micro = int(row.credit_micro_usd);
    const balance = await credit(q, row.workspace_id, micro, "burn", sig);
    return { ok: true as const, signature: sig, workspaceId: row.workspace_id, creditMicroUsd: micro, balanceMicroUsd: balance };
  });
  if (done) return done;
  const seen = await db.query("SELECT 1 FROM burns WHERE signature = $1", [sig]);
  return { ok: false, reason: seen.length ? "not_in_review" : "not_found" };
}

// ---- CLI ----

const usd = (micro: number) => `$${formatMicroUsd(micro)}`;
const REFUSED: Record<"invalid_signature" | "not_found" | "not_in_review", string> = {
  invalid_signature: "That is not a base58 transaction signature.",
  not_found: "No burn with that signature. Have the user verify it in /app first (or POST /api/burns/verify).",
  not_in_review: "That burn is not in review: it is already credited. Nothing to do.",
};

function describe(b: ReviewBurn): string {
  return [
    `  signature   ${b.signature}`,
    `  workspace   ${b.workspaceId}`,
    `  owner       ${b.owner}`,
    `  burned      ${b.amountUi} at $${b.priceUsd} = $${b.usdValue}`,
    `  credit      ${usd(b.creditMicroUsd)}`,
    `  block time  ${b.blockTime}   verified ${b.verifiedAt}`,
  ].join("\n");
}

/** The command line. `open` connects to DATABASE_URL (Neon, as in production); tests pass their own database. */
export async function cli(argv: string[], open: (url: string) => Promise<Db> = openNeon): Promise<number> {
  const [cmd, sig, ...rest] = argv;
  const yes = rest.includes("--yes") || sig === "--yes";
  if (cmd !== "list" && cmd !== "approve") {
    console.error("usage: npm run review -- list | approve <signature> [--yes]");
    return 2;
  }
  if (cmd === "approve" && (!sig || sig.startsWith("--"))) {
    console.error("usage: npm run review -- approve <signature> [--yes]");
    return 2;
  }
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("DATABASE_URL is not set. Export the production Neon connection string first (it is never printed).");
    return 2;
  }
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {}
  console.log(`database ${host}`);
  const db = await open(url);

  if (cmd === "list") {
    const burns = await listReviewBurns(db);
    if (!burns.length) {
      console.log("No burns in review.");
      return 0;
    }
    const total = burns.reduce((a, b) => a + b.creditMicroUsd, 0);
    console.log(`${burns.length} burn(s) in review, ${usd(total)} of credit held:\n`);
    for (const b of burns) console.log(`${describe(b)}\n`);
    console.log("Approve one with: npm run review -- approve <signature>");
    return 0;
  }

  const plan = await planApproval(db, sig!);
  if (!plan.ok) {
    console.error(REFUSED[plan.reason]);
    if (plan.burn) console.error(describe(plan.burn));
    return 1;
  }
  console.log(`Burn in review:\n${describe(plan.burn)}`);
  console.log(`\nApproving credits ${usd(plan.burn.creditMicroUsd)} to ${plan.burn.workspaceId}: balance ${usd(plan.balanceMicroUsd)} -> ${usd(plan.balanceMicroUsd + plan.burn.creditMicroUsd)}.`);
  if (plan.grants.length) {
    console.log(`\nThis workspace already has ${plan.grants.length} operator grant(s). If any of them paid this burn by hand, do not approve: it would pay twice.`);
    for (const g of plan.grants) console.log(`  ${g.at}  ${usd(g.microUsd)}  ${g.ref}`);
  }
  if (!yes) {
    console.log("\nDry run: nothing written. Re-run with --yes to credit it.");
    return 0;
  }
  const r = await approveReviewBurn(db, sig!);
  if (!r.ok) {
    console.error(REFUSED[r.reason]);
    return 1;
  }
  console.log(`\nApproved: ${usd(r.creditMicroUsd)} credited to ${r.workspaceId}, balance now ${usd(r.balanceMicroUsd)}. The burn is 'credited'.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error("FAIL:", err instanceof Error ? err.message : err);
    return 1;
  });
}
