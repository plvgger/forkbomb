// Review-burn release against the real server code: a burn over the per-burn cap goes through verifyBurn into
// 'review', then approveReviewBurn pays it once and the verifier, ledger and balance all agree it is credited.
// In-memory PGlite with the web app's migrations, a stubbed Solana RPC, no network.
// Run: cd ops && npm test

import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { listLedger, verifyBurn, type ParsedTransaction } from "../web/lib/server/burns";
import { credit, getBalance } from "../web/lib/server/credits";
import { openPglite, setDb, type Db } from "../web/lib/server/db";
import { loadMigrations, migrate } from "../web/lib/server/migrate";
import { burnMemo, createWorkspace } from "../web/lib/server/workspaces";
import { burnTx, MINT, randomSignature } from "../web/test/fixtures/transactions";
import { approveReviewBurn, cli, listReviewBurns, planApproval } from "./review-burns";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
const RPC_URL = "https://rpc.test.invalid";
const MIN = 60_000;
const NOW = new Date("2026-10-06T12:00:00Z");
const BLOCK_TIME = new Date(NOW.getTime() - 20 * MIN); // old enough that no live quote is ever used
/** 1,000,000 tokens at 6 decimals x $0.0051 = $5100: over the default $5000 review cap and the $100 grant cap. */
const ONE_MILLION = "1000000000000";
const PRICE = "0.0051";
const CREDIT = 5_100_000_000;

let db: Db;
let ws: string;
const txs = new Map<string, ParsedTransaction>();
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

/** A finalized burn of ONE_MILLION with this workspace's memo, served by the stub RPC. */
function putBurn(workspaceId: string): string {
  const signature = randomSignature();
  txs.set(signature, burnTx({ signature, blockTime: Math.floor(BLOCK_TIME.getTime() / 1000), burns: [{ amount: ONE_MILLION }], memo: burnMemo(workspaceId) }));
  return signature;
}

/** A burn recorded in 'review' the way production records it: through verifyBurn. */
async function reviewBurn(workspaceId = ws): Promise<string> {
  const sig = putBurn(workspaceId);
  const burn = await verifyBurn(sig, { now: NOW });
  assert.equal(burn.status, "review");
  assert.equal(burn.creditMicroUsd, CREDIT);
  return sig;
}

beforeEach(async () => {
  // Production defaults: MAX_CREDIT_PER_BURN_USD and MAX_GRANT_USD unset ($5000 and $100).
  for (const k of ["DATABASE_URL", "MAX_CREDIT_PER_BURN_USD", "MAX_GRANT_USD", "CREDIT_MULTIPLIER"]) delete process.env[k];
  Object.assign(process.env, { TOKEN_MINT: MINT, SOLANA_RPC_URL: RPC_URL });
  txs.clear();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== RPC_URL) throw new Error(`unexpected fetch in test: ${url}`);
    const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const result = req.method === "getTransaction" ? (txs.get(req.params[0] as string) ?? null) : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  db = await openPglite();
  await migrate(db, await loadMigrations(join(WEB, "db", "migrations")));
  setDb(db);
  ws = (await createWorkspace({ label: "review" })).workspace.id;
  for (const m of [-20, -15, -10, -5, 0, 5, 10]) {
    await db.query("INSERT INTO price_samples (mint, ts, price_usd, source) VALUES ($1, $2, $3, 'jupiter')", [
      MINT,
      new Date(BLOCK_TIME.getTime() + m * MIN).toISOString(),
      PRICE,
    ]);
  }
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  setDb(null);
  await db.close();
});

describe("approveReviewBurn", () => {
  it("pays a review burn over the grant cap once, and the verifier, ledger and balance agree it is credited", async () => {
    const sig = await reviewBurn();
    assert.equal(sig.length, 88); // longer than the 64-char admin grant ref: the grant route can't name it
    assert.equal(await getBalance(ws), 0);
    assert.deepEqual((await listReviewBurns(db)).map((b) => b.signature), [sig]);

    const r = await approveReviewBurn(db, sig);
    assert.deepEqual(r, { ok: true, signature: sig, workspaceId: ws, creditMicroUsd: CREDIT, balanceMicroUsd: CREDIT });
    assert.equal(await getBalance(ws), CREDIT);

    // What the dApp sees on its next verify, and what the public ledger shows.
    assert.equal((await verifyBurn(sig, { now: NOW })).status, "already_credited");
    const ledger = await listLedger();
    assert.equal(ledger.burns.find((b) => b.signature === sig)?.status, "credited");
    assert.equal(ledger.totals.creditedMicroUsd, CREDIT);
    assert.deepEqual(await listReviewBurns(db), []);

    // Booked like any other burn credit: reason 'burn', ref = signature.
    const rows = await db.query<{ reason: string; ref: string; delta_micro_usd: unknown }>(
      "SELECT reason, ref, delta_micro_usd FROM credit_ledger WHERE workspace_id = $1",
      [ws],
    );
    assert.deepEqual(rows.map((x) => [x.reason, x.ref, Number(x.delta_micro_usd)]), [["burn", sig, CREDIT]]);
  });

  it("credits nothing on a second or concurrent approve", async () => {
    const sig = await reviewBurn();
    const both = await Promise.all([approveReviewBurn(db, sig), approveReviewBurn(db, sig)]);
    assert.deepEqual(both.map((x) => x.ok).sort(), [false, true]);
    assert.deepEqual(both.find((x) => !x.ok), { ok: false, reason: "not_in_review" });
    assert.deepEqual(await approveReviewBurn(db, sig), { ok: false, reason: "not_in_review" });
    assert.equal(await getBalance(ws), CREDIT);
  });

  it("refuses an unknown signature, a malformed one, and a burn that was credited normally", async () => {
    process.env.MAX_CREDIT_PER_BURN_USD = "10000";
    const normal = putBurn(ws);
    assert.equal((await verifyBurn(normal, { now: NOW })).status, "credited");
    assert.deepEqual(await approveReviewBurn(db, normal), { ok: false, reason: "not_in_review" });
    assert.deepEqual(await approveReviewBurn(db, randomSignature()), { ok: false, reason: "not_found" });
    assert.deepEqual(await approveReviewBurn(db, "not-a-signature"), { ok: false, reason: "invalid_signature" });
    assert.equal(await getBalance(ws), CREDIT);
  });

  it("rolls the status back if the credit can't be booked", async () => {
    const sig = await reviewBurn();
    // A pre-existing 'burn' credit for this signature makes credit() hit the (reason, ref) unique key.
    await db.tx((q) => credit(q, ws, 1, "burn", sig));
    await assert.rejects(approveReviewBurn(db, sig));
    assert.equal((await verifyBurn(sig, { now: NOW })).status, "review");
    assert.equal(await getBalance(ws), 1);
  });
});

describe("planApproval", () => {
  it("shows the burn, the balance and earlier operator grants, and writes nothing", async () => {
    const sig = await reviewBurn();
    await db.tx((q) => credit(q, ws, 61_728_000, "grant", "admin:review-payout-1"));
    const plan = await planApproval(db, ` ${sig} `);
    assert.ok(plan.ok);
    assert.equal(plan.burn.signature, sig);
    assert.equal(plan.burn.workspaceId, ws);
    assert.equal(plan.burn.creditMicroUsd, CREDIT);
    assert.equal(plan.burn.usdValue, "5100");
    assert.equal(plan.balanceMicroUsd, 61_728_000);
    assert.deepEqual(plan.grants.map((g) => [g.ref, g.microUsd]), [["admin:review-payout-1", 61_728_000]]);
    assert.equal((await verifyBurn(sig, { now: NOW })).status, "review");
  });

  it("reports a burn that is not in review", async () => {
    const sig = await reviewBurn();
    await approveReviewBurn(db, sig);
    const plan = await planApproval(db, sig);
    assert.equal(plan.ok, false);
    assert.equal(!plan.ok && plan.reason, "not_in_review");
    assert.deepEqual(await planApproval(db, randomSignature()), { ok: false, reason: "not_found" });
  });
});

describe("cli", () => {
  /** Runs the command line on the test database with a fake DATABASE_URL; returns exit code and everything printed. */
  async function run(...argv: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const log = mock.method(console, "log", (...a: unknown[]) => lines.push(a.join(" ")));
    const err = mock.method(console, "error", (...a: unknown[]) => lines.push(a.join(" ")));
    try {
      const code = await cli(argv, async () => db);
      return { code, out: lines.join("\n") };
    } finally {
      log.mock.restore();
      err.mock.restore();
    }
  }

  it("lists, dry-runs without writing, approves only with --yes, and never prints the database URL", async () => {
    process.env.DATABASE_URL = "postgresql://ops:s3cr3t-pw@ep-test-123.neon.test.invalid/neondb?sslmode=require";
    const sig = await reviewBurn();

    const list = await run("list");
    assert.equal(list.code, 0);
    assert.match(list.out, /database ep-test-123\.neon\.test\.invalid/);
    assert.match(list.out, /1 burn\(s\) in review, \$5100\.000000 of credit held/);
    assert.ok(list.out.includes(sig));

    const dry = await run("approve", sig);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /balance \$0\.000000 -> \$5100\.000000/);
    assert.match(dry.out, /Dry run: nothing written/);
    assert.equal((await verifyBurn(sig, { now: NOW })).status, "review");
    assert.equal(await getBalance(ws), 0);

    const yes = await run("approve", sig, "--yes");
    assert.equal(yes.code, 0);
    assert.match(yes.out, /Approved: \$5100\.000000 credited/);
    assert.equal(await getBalance(ws), CREDIT);

    const again = await run("approve", sig, "--yes");
    assert.equal(again.code, 1);
    assert.match(again.out, /already credited/);
    assert.equal(await getBalance(ws), CREDIT);

    for (const r of [list, dry, yes, again]) assert.ok(!r.out.includes("s3cr3t-pw"));
  });

  it("warns about earlier operator grants before approving", async () => {
    process.env.DATABASE_URL = "postgresql://ops:pw@ep-test.neon.test.invalid/neondb";
    const sig = await reviewBurn();
    await db.tx((q) => credit(q, ws, 61_728_000, "grant", "admin:review-payout-1"));
    const dry = await run("approve", sig);
    assert.match(dry.out, /already has 1 operator grant\(s\)\. If any of them paid this burn by hand, do not approve/);
    assert.match(dry.out, /\$61\.728000 {2}admin:review-payout-1/);
  });

  it("refuses to run without DATABASE_URL or with bad arguments", async () => {
    assert.equal((await run("list")).code, 2);
    assert.match((await run("list")).out, /DATABASE_URL is not set/);
    process.env.DATABASE_URL = "postgresql://ops:pw@ep-test.neon.test.invalid/neondb";
    assert.equal((await run()).code, 2);
    assert.equal((await run("approve")).code, 2);
    assert.equal((await run("approve", "--yes")).code, 2);
    assert.equal((await run("approve", randomSignature(), "--yes")).code, 1);
    assert.equal((await run("approve", "nope", "--yes")).code, 1);
  });
});
