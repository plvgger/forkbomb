// Devnet end-to-end burn test against the real server code in ../web/lib/server.
// Run: cd ops && npx tsx devnet-burn-e2e.ts
//
// Makes a throwaway devnet payer (ops/.keys/, gitignored, secret never printed), airdrops devnet SOL,
// creates a 6-decimal mint, mints 1,000,000 tokens, then for a classic SPL mint and a Token-2022 mint:
//   burnChecked 250,000 + memo "forkbomb:<workspaceId>" -> verifyBurn credits exactly floor(250000 * $0.002 * 1e6)
//   verifyBurn again -> already_credited, no extra credit
//   burnChecked with a wrong memo -> bad_memo, no credit
// Uses an in-memory PGlite with the web app's migrations. Never touches mainnet.
// Exit codes: 0 PASS, 1 FAIL, 2 faucet refused (nothing was tested).
//
// E2E_RPC_URL overrides the cluster, for a local validator when the devnet faucet is rate-limited:
//   solana-test-validator --reset --ledger .ledger &  E2E_RPC_URL=http://127.0.0.1:8899 npx tsx devnet-burn-e2e.ts
// Only devnet and loopback URLs are accepted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  type Finality,
} from "@solana/web3.js";
import {
  createBurnCheckedInstruction,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const DEVNET_RPC = "https://api.devnet.solana.com";
const RPC_URL = (process.env.E2E_RPC_URL || DEVNET_RPC).trim();
const IS_LOCAL = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(RPC_URL).hostname);
if (RPC_URL !== DEVNET_RPC && !IS_LOCAL) {
  console.error(`Refusing to run against ${RPC_URL}: only ${DEVNET_RPC} or a loopback validator.`);
  process.exit(1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "web");
const KEY_FILE = join(HERE, ".keys", IS_LOCAL ? "localnet-payer.json" : "devnet-payer.json");

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const MINT_UI = 1_000_000n;
const BURN_UI = 250_000n;
const WRONG_MEMO_BURN_UI = 1_000n;
const PRICE_USD = "0.002";
/** floor(250000 * 0.002 * 1e6), in integers: 250000 * 2 / 1000 USD -> micro-USD. */
const EXPECTED_CREDIT_MICRO = Number((BURN_UI * 2n * 1_000_000n) / 1000n);
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// The server reads these. BRAND is fixed at module load, so set env before importing it.
// DATABASE_URL stays unset: the server falls back to in-memory PGlite outside production.
delete process.env.DATABASE_URL;
Object.assign(process.env, {
  NODE_ENV: "test",
  SOLANA_RPC_URL: RPC_URL,
  KEY_PEPPER: "test",
  BRAND_NAME: "FORKBOMB",
  BRAND_TICKER: "FORKBOMB",
});

const server = {
  burns: await import("../web/lib/server/burns"),
  credits: await import("../web/lib/server/credits"),
  db: await import("../web/lib/server/db"),
  migrate: await import("../web/lib/server/migrate"),
  workspaces: await import("../web/lib/server/workspaces"),
};

// ---- report ----

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const txLink = (sig: string) => (IS_LOCAL ? `localnet tx ${sig}` : `https://solscan.io/tx/${sig}?cluster=devnet`);
const tokenLink = (mint: string) => (IS_LOCAL ? "localnet" : `https://solscan.io/token/${mint}?cluster=devnet`);

function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

const log = (msg: string) => console.log(msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- devnet setup ----

function loadOrCreatePayer(): Keypair {
  if (existsSync(KEY_FILE)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, "utf8")) as number[]));
  }
  const kp = Keypair.generate();
  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(KEY_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

class FaucetRefused extends Error {}

/** Airdrop until the payer holds at least minSol. Exponential backoff; tries smaller amounts when refused. */
async function fund(conn: Connection, payer: PublicKey, minSol: number): Promise<number> {
  const have = await conn.getBalance(payer, "confirmed");
  if (have >= minSol * LAMPORTS_PER_SOL) return have;
  const amounts = [1, 1, 0.5, 0.5, 0.25, 0.25];
  let lastErr = "";
  for (let i = 0; i < amounts.length; i++) {
    try {
      const sig = await conn.requestAirdrop(payer, amounts[i]! * LAMPORTS_PER_SOL);
      const latest = await conn.getLatestBlockhash("confirmed");
      await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      const bal = await conn.getBalance(payer, "confirmed");
      log(`  airdrop ${amounts[i]} SOL ok  ${txLink(sig)}`);
      if (bal >= minSol * LAMPORTS_PER_SOL) return bal;
    } catch (err) {
      lastErr = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      const wait = 2_000 * 2 ** i;
      const last = i === amounts.length - 1;
      log(`  airdrop attempt ${i + 1}/${amounts.length} refused: ${lastErr.slice(0, 160)}${last ? "" : `; retry in ${wait / 1000}s`}`);
      if (!last) await sleep(wait);
    }
  }
  throw new FaucetRefused(lastErr);
}

function memoIx(signer: PublicKey, memo: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

/** burnChecked + memo in one transaction, waited to finalization. Returns the signature. */
async function burnWithMemo(
  conn: Connection,
  payer: Keypair,
  ata: PublicKey,
  mint: PublicKey,
  uiAmount: bigint,
  memo: string,
  programId: PublicKey,
): Promise<string> {
  const tx = new Transaction().add(
    createBurnCheckedInstruction(ata, mint, payer.publicKey, uiAmount * UNIT, DECIMALS, [], programId),
    memoIx(payer.publicKey, memo),
  );
  // Simulate at "confirmed": the mint and ATA were just created and are not finalized yet.
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "finalized" satisfies Finality, preflightCommitment: "confirmed" });
}

async function blockTimeOf(conn: Connection, sig: string): Promise<Date> {
  for (let i = 0; i < 20; i++) {
    const tx = await conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (tx?.blockTime) return new Date(tx.blockTime * 1000);
    await sleep(3_000);
  }
  throw new Error(`no finalized block time for ${sig}`);
}

/** Seed price_samples so $0.002 covers blockTime per lib/server/price.ts: a pre-burn anchor, 2+ samples in window, one after. */
async function seedPrice(mint: string, blockTime: Date): Promise<void> {
  const db = await server.db.getDb();
  const bt = blockTime.getTime();
  for (const ts of [bt - 10 * 60_000, bt - 5 * 60_000, bt + 1_000]) {
    await db.query("INSERT INTO price_samples (mint, ts, price_usd, source) VALUES ($1, $2, $3, $4)", [
      mint,
      new Date(ts).toISOString(),
      PRICE_USD,
      "devnet-e2e",
    ]);
  }
}

/** verifyBurn, retrying only transient RPC/finality errors (public devnet RPC rate-limits). */
async function verify(sig: string) {
  for (let i = 0; ; i++) {
    try {
      return await server.burns.verifyBurn(sig);
    } catch (err) {
      const code = err instanceof server.burns.BurnError ? err.burnCode : "";
      if (i < 8 && (code === "rpc_error" || code === "not_finalized" || code === "not_found")) {
        await sleep(3_000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

async function burnCodeOf(sig: string): Promise<string> {
  try {
    const r = await verify(sig);
    return `no error (status ${r.status})`;
  } catch (err) {
    return err instanceof server.burns.BurnError ? err.burnCode : `unexpected: ${String(err)}`;
  }
}

// ---- one full pass per token program ----

async function runFor(conn: Connection, payer: Keypair, label: string, programId: PublicKey): Promise<void> {
  log(`\n== ${label} (${programId.toBase58()}) ==`);
  const known = label === "Token-2022" ? server.burns.TOKEN_2022_PROGRAM : server.burns.TOKEN_PROGRAM;
  check(`${label}: server program id matches spl-token`, known === programId.toBase58(), `burns.ts has ${known}`);
  const mint = await createMint(conn, payer, payer.publicKey, null, DECIMALS, Keypair.generate(), { commitment: "confirmed" }, programId);
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey, false, "confirmed", undefined, programId);
  const mintSig = await mintTo(conn, payer, mint, ata.address, payer, MINT_UI * UNIT, [], { commitment: "confirmed" }, programId);
  log(`  mint ${mint.toBase58()}  ${tokenLink(mint.toBase58())}`);
  log(`  minted ${MINT_UI} to ${ata.address.toBase58()}  ${txLink(mintSig)}`);

  process.env.TOKEN_MINT = mint.toBase58();
  const { workspace } = await server.workspaces.createWorkspace({ label: `devnet-e2e ${label}` });
  const memo = server.workspaces.burnMemo(workspace.id);
  log(`  workspace ${workspace.id}, memo "${memo}"`);

  const sig = await burnWithMemo(conn, payer, ata.address, mint, BURN_UI, memo, programId);
  log(`  burn ${BURN_UI} finalized  ${txLink(sig)}`);
  const blockTime = await blockTimeOf(conn, sig);
  await seedPrice(mint.toBase58(), blockTime);

  const first = await verify(sig);
  check(`${label}: status credited`, first.status === "credited", first.status);
  check(
    `${label}: credit_micro_usd == ${EXPECTED_CREDIT_MICRO}`,
    first.creditMicroUsd === EXPECTED_CREDIT_MICRO,
    `got ${first.creditMicroUsd}, price $${first.priceUsd}, usd ${first.usdValue}`,
  );
  check(`${label}: amount and owner read from chain`, first.amountRaw === String(BURN_UI * UNIT) && first.owner === payer.publicKey.toBase58(), `${first.amountUi} by ${first.owner}`);
  const bal1 = await server.credits.getBalance(workspace.id);
  check(`${label}: balance updated`, bal1 === EXPECTED_CREDIT_MICRO, `balance ${bal1}`);

  const second = await verify(sig);
  const bal2 = await server.credits.getBalance(workspace.id);
  check(`${label}: replay returns already_credited`, second.status === "already_credited", second.status);
  check(`${label}: replay adds no credit`, bal2 === bal1, `balance ${bal2}`);

  const badSig = await burnWithMemo(conn, payer, ata.address, mint, WRONG_MEMO_BURN_UI, `${memo}-tampered`, programId);
  log(`  wrong-memo burn finalized  ${txLink(badSig)}`);
  const badCode = await burnCodeOf(badSig);
  const bal3 = await server.credits.getBalance(workspace.id);
  check(`${label}: wrong memo rejected bad_memo`, badCode === "bad_memo", badCode);
  check(`${label}: wrong memo adds no credit`, bal3 === bal1, `balance ${bal3}`);
}

/** First line of an error, plus program logs when a transaction failed simulation. */
function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  const logs = (err as { logs?: unknown } | null)?.logs;
  return Array.isArray(logs) && logs.length ? `${msg} logs: ${logs.slice(-4).join(" | ")}` : msg;
}

async function main(): Promise<number> {
  log(`FORKBOMB burn e2e on ${IS_LOCAL ? `local validator ${RPC_URL}` : "devnet"} (in-memory PGlite, real web/lib/server code)`);
  const db = await server.db.openPglite();
  await server.migrate.migrate(db, await server.migrate.loadMigrations(join(WEB, "db", "migrations")));
  server.db.setDb(db);

  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadOrCreatePayer();
  log(`payer ${payer.publicKey.toBase58()} (secret in ops/.keys/, not printed)`);
  try {
    const lamports = await fund(conn, payer.publicKey, 0.1);
    log(`  balance ${lamports / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    if (!(err instanceof FaucetRefused)) throw err;
    log(`\nBLOCKED: the faucet refused every airdrop (${err.message.slice(0, 200)}).`);
    log(`Nothing was tested. Fund ${payer.publicKey.toBase58()} with devnet SOL (or set E2E_RPC_URL to a local validator) and rerun; the key is kept in ops/.keys/.`);
    return 2;
  }

  for (const [label, programId] of [["SPL Token", TOKEN_PROGRAM_ID], ["Token-2022", TOKEN_2022_PROGRAM_ID]] as const) {
    try {
      await runFor(conn, payer, label, programId);
    } catch (err) {
      check(`${label}: ran to completion`, false, describe(err));
    }
  }

  await db.close();
  const failed = checks.filter((c) => !c.ok);
  log(`\n${failed.length ? "FAIL" : "PASS"}: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const c of failed) log(`  failed: ${c.name}  ${c.detail}`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main().catch((err: unknown) => {
  console.error("FAIL: unexpected error:", err instanceof Error ? err.message : err);
  return 1;
});
