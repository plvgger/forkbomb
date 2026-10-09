// Browser end-to-end for burn-for-credit through the REAL /app dApp UI, on a local Solana validator.
//
//   cd ops && npm run e2e:dapp            (installs puppeteer-core into ops/e2e on first run)
//
// What it does, all on loopback, nothing on mainnet or devnet:
//   1. Starts solana-test-validator on free ports (or uses E2E_RPC_URL, loopback only), creates a 6-decimal
//      classic SPL mint and a 6-decimal Token-2022 mint, and funds a throwaway wallet keypair (memory only).
//   2. Clones web/ into the output dir (APFS clone on macOS, so web/.next is never touched; `npm ci` in the clone
//      when web/node_modules is behind package-lock.json) and runs `next dev` on it with TOKEN_MINT,
//      SOLANA_RPC_URL, CRON_SECRET, ADMIN_SECRET, a low MAX_CREDIT_PER_BURN_USD and no DATABASE_URL (in-memory
//      PGlite; `next start` can't run without DATABASE_URL by design). price-stub.mjs is preloaded into the server
//      process only and answers Jupiter/DexScreener for the test mints at a fixed price (or a 503 outage).
//      Classic: /api/cron/price is called with the secret before each burn. Token-2022: the cron never succeeds;
//      prices come only from the on-demand sampling in GET /api/price, as in production without a scheduler.
//   3. Drives /app in headless Chrome (puppeteer-core). wallet-inject.js registers a Wallet Standard wallet
//      before page scripts run; it signs and sends in Node through page.exposeFunction.
//   4. Scenarios: connect (declined, then approved), create workspace + key reveal, amount edge cases, burn
//      1234.5 -> credited and /api/v1/me == floor(amount x price x 1e6), ledger API + /burns page, replay via API
//      and via the UI's signature form, wallet rejection, over-balance (UI guard and stale balance), a burn over
//      the review cap, a Phantom-shaped transaction (ComputeBudget x2 + a no-op added by the wallet), a
//      legacy-only wallet, a hand-built transaction with extra instructions verified by signature, then with
//      TOKEN_MINT = the Token-2022 mint: price feed down (burning paused), feed back (reopens with no cron), the
//      main burn again, and a reload while the burn finalizes.
// Exit code 0 PASS, 1 FAIL; harness-side retries print as WARN. Screenshots, server and validator logs land in the
// output dir it prints.
//
// Env: E2E_RPC_URL (reuse a loopback validator), E2E_OUT_DIR, E2E_WEB_COPY (reuse a clone of web/),
//      CHROME_PATH, E2E_HEADFUL=1, SOLANA_TEST_VALIDATOR (path to the binary).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_WEB = join(HERE, "..", "..", "web");
const OUT = process.env.E2E_OUT_DIR || join(tmpdir(), `forkbomb-dapp-e2e-${Date.now()}`);
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");

const DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const MINT_UI = 1_000_000n;
const PRICE_USD = "0.0123456";
const REVIEW_CAP_USD = "50";
const MAIN_BURN = "1234.5"; // $15.2406432 -> 15,240,643 micro-USD (floor drops 0.2)
const REVIEW_BURN = "5000"; // $61.728, over the $50 cap
const PHANTOM_BURN = "100"; // $1.23456
const DIRECT_BURN = "77.7"; // $0.95925312
const LEGACY_BURN = "42"; // $0.5185152
const STALE_BURN = "500";
const RELOAD_BURN = "10"; // $0.123456
/** price-stub.mjs re-reads this on every request: a price, or "down" for an outage of both sources. */
const PRICE_FILE = join(OUT, "price.txt");
const MEMO_V1 = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
const MEMO_V2 = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SECRETS = { cron: randomBytes(24).toString("hex"), admin: randomBytes(32).toString("hex"), pepper: randomBytes(16).toString("hex") };

// ---- report ----

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}
const log = (msg: string) => console.log(msg);
/** Harness-side retries and oddities that didn't fail a check. Printed at the end and kept in results.json. */
const warnings: string[] = [];
function warn(msg: string): void {
  warnings.push(msg);
  console.log(`  WARN  ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0]! : String(err));

/** Exact decimal string -> integer scaled by 10^scale. Throws on anything else. */
function scaled(s: string, scale: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > scale) throw new Error(`bad decimal ${s}`);
  return BigInt(m[1]! + (m[2] ?? "").padEnd(scale, "0"));
}
const PRICE_ATTO = scaled(PRICE_USD, 18);
/** floor(amount x price x 1e6), computed independently of the server: raw * priceAtto / 1e18. */
const expectedCredit = (ui: string) => Number((scaled(ui, DECIMALS) * PRICE_ATTO) / 10n ** 18n);

// ---- processes ----

const procs: ChildProcess[] = [];
function stop(p: ChildProcess | null | undefined): void {
  if (!p || p.exitCode !== null || p.pid === undefined) return;
  try {
    process.kill(-p.pid, "SIGTERM");
  } catch {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
}
async function stopAndWait(p: ChildProcess | null | undefined): Promise<void> {
  if (!p || p.exitCode !== null) return;
  const done = new Promise<void>((r) => p.once("exit", () => r()));
  stop(p);
  await Promise.race([done, sleep(8_000)]);
  if (p.exitCode === null && p.pid !== undefined) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  }
}
function cleanupAll(): void {
  for (const p of procs) stop(p);
}
process.on("exit", cleanupAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined>, timeoutMs: number, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && (v as unknown) !== false) return v;
    } catch (err) {
      last = errText(err);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

// ---- validator ----

function validatorBin(): string {
  const candidates = [
    process.env.SOLANA_TEST_VALIDATOR,
    join(homedir(), ".local/share/solana/install/active_release/bin/solana-test-validator"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return "solana-test-validator";
}

async function rpcHealthy(url: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await res.json()) as { result?: string };
  return body.result === "ok";
}

async function startValidator(): Promise<{ rpcUrl: string; proc: ChildProcess | null }> {
  const given = process.env.E2E_RPC_URL?.trim();
  if (given) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(given).hostname)) {
      throw new Error(`E2E_RPC_URL must be a loopback validator, got ${given}`);
    }
    await waitFor("validator health", () => rpcHealthy(given), 10_000);
    return { rpcUrl: given, proc: null };
  }
  const rpcPort = await freePort();
  const base = 20_000 + Math.floor(Math.random() * 20_000);
  const ledger = join(OUT, "ledger");
  const logFd = openSync(join(OUT, "validator.log"), "a");
  const proc = spawn(
    validatorBin(),
    [
      "--reset", "--quiet", "--ledger", ledger,
      "--rpc-port", String(rpcPort),
      "--faucet-port", String(base),
      "--gossip-port", String(base + 1),
      "--dynamic-port-range", `${base + 2}-${base + 40}`,
      "--limit-ledger-size", "50000000",
    ],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  closeSync(logFd);
  procs.push(proc);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  await waitFor("validator health", () => rpcHealthy(rpcUrl), 90_000);
  return { rpcUrl, proc };
}

// ---- chain setup ----

type Chain = {
  conn: Connection;
  operator: Keypair;
  wallet: Keypair;
  mints: { classic: PublicKey; t22: PublicKey };
  atas: { classic: PublicKey; t22: PublicKey };
};

async function airdrop(conn: Connection, to: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

async function setupChain(rpcUrl: string): Promise<Chain> {
  const conn = new Connection(rpcUrl, "confirmed");
  const operator = Keypair.generate();
  const wallet = Keypair.generate();
  await airdrop(conn, operator.publicKey, 10);
  await airdrop(conn, wallet.publicKey, 2);
  const mk = async (programId: PublicKey) => {
    const mint = await createMint(conn, operator, operator.publicKey, null, DECIMALS, Keypair.generate(), { commitment: "confirmed" }, programId);
    const ata = await getOrCreateAssociatedTokenAccount(conn, operator, mint, wallet.publicKey, false, "confirmed", undefined, programId);
    await mintTo(conn, operator, mint, ata.address, operator, MINT_UI * UNIT, [], { commitment: "confirmed" }, programId);
    return { mint, ata: ata.address };
  };
  const classic = await mk(TOKEN_PROGRAM_ID);
  const t22 = await mk(TOKEN_2022_PROGRAM_ID);
  return { conn, operator, wallet, mints: { classic: classic.mint, t22: t22.mint }, atas: { classic: classic.ata, t22: t22.ata } };
}

async function tokenBalance(chain: Chain, ata: PublicKey, programId: PublicKey): Promise<bigint> {
  return (await getAccount(chain.conn, ata, "confirmed", programId)).amount;
}

// ---- web server ----

/** Direct dependencies whose installed version differs from package-lock.json, e.g. "react 19.1.1 (lock 19.3.0)". */
function staleDeps(webDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const lock = JSON.parse(readFileSync(join(webDir, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string }> };
  const out: string[] = [];
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const want = lock.packages?.[`node_modules/${name}`]?.version;
    let have = "missing";
    try {
      have = (JSON.parse(readFileSync(join(webDir, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
    } catch {}
    if (want && have !== want) out.push(`${name} ${have} (lock ${want})`);
  }
  return out;
}

function cloneWeb(): string {
  if (process.env.E2E_WEB_COPY) {
    const stale = staleDeps(process.env.E2E_WEB_COPY);
    if (stale.length) log(`warning: E2E_WEB_COPY node_modules differ from its package-lock.json: ${stale.join(", ")}`);
    return process.env.E2E_WEB_COPY;
  }
  const dest = join(OUT, "web");
  if (!existsSync(join(dest, "package.json"))) {
    mkdirSync(dest, { recursive: true });
    // Never copy build output, Vercel project files or env files (they can hold production secrets).
    const skip = (name: string) => name === ".next" || name === ".vercel" || name.startsWith(".env");
    for (const name of readdirSync(REPO_WEB)) {
      if (skip(name)) continue;
      const src = join(REPO_WEB, name);
      try {
        if (process.platform !== "darwin") throw new Error("no clonefile");
        execFileSync("cp", ["-cR", src, dest], { stdio: "ignore" }); // APFS clone: instant, no extra disk
      } catch {
        cpSync(src, join(dest, name), { recursive: true });
      }
    }
  }
  // Test what the lockfile pins, not whatever web/node_modules last had installed. Only the clone is reinstalled.
  const stale = staleDeps(dest);
  if (stale.length) {
    log(`web/node_modules is behind package-lock.json (${stale.join(", ")}); npm ci in the clone`);
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dest, stdio: ["ignore", "inherit", "inherit"] });
    const still = staleDeps(dest);
    if (still.length) throw new Error(`npm ci left dependencies off the lockfile: ${still.join(", ")}`);
  }
  return dest;
}

type Web = { proc: ChildProcess; base: string; mint: string; log: string };

async function startWeb(webDir: string, chain: Chain, rpcUrl: string, mint: PublicKey, label: string): Promise<Web> {
  const port = await freePort();
  const logPath = join(OUT, `web-${label}.log`);
  const logFd = openSync(logPath, "a");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(DATABASE_URL|UPSTREAM_|TOKEN_MINT|SOLANA_RPC_URL|CRON_SECRET|ADMIN_SECRET|KEY_PEPPER|MAX_|VERCEL|NEXT_PUBLIC_|NODE_OPTIONS|E2E_)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    NEXT_TELEMETRY_DISABLED: "1",
    TOKEN_MINT: mint.toBase58(),
    SOLANA_RPC_URL: rpcUrl,
    CRON_SECRET: SECRETS.cron,
    ADMIN_SECRET: SECRETS.admin,
    KEY_PEPPER: SECRETS.pepper,
    MAX_CREDIT_PER_BURN_USD: REVIEW_CAP_USD,
    E2E_PRICE_USD: PRICE_USD,
    E2E_PRICE_FILE: PRICE_FILE,
    E2E_PRICE_MINTS: [chain.mints.classic, chain.mints.t22].map((m) => m.toBase58()).join(","),
    NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, "price-stub.mjs")).href}`,
  });
  const proc = spawn(process.execPath, [join(webDir, "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: webDir,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    "web server",
    async () => {
      if (proc.exitCode !== null) throw new Error(`next dev exited ${proc.exitCode}; see ${logPath}`);
      const r = await fetch(`${base}/api/token`, { signal: AbortSignal.timeout(60_000) });
      return r.ok;
    },
    240_000,
    1_000,
  );
  return { proc, base, mint: mint.toBase58(), log: logPath };
}

// ---- HTTP API ----

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(base: string, path: string, init: { method?: string; body?: unknown; key?: string; auth?: string } = {}): Promise<{ status: number; body: Json }> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
        ...(init.auth ? { authorization: init.auth } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.status === 429 && i < 5) {
      await sleep(Math.max(1, Number(res.headers.get("retry-after")) || 5) * 1000);
      continue;
    }
    return { status: res.status, body };
  }
}

async function samplePrice(web: Web, n = 1): Promise<Json[]> {
  const out: Json[] = [];
  for (let i = 0; i < n; i++) {
    if (i) await sleep(1_200);
    const r = await api(web.base, "/api/cron/price", { method: "POST", auth: `Bearer ${SECRETS.cron}` });
    out.push({ status: r.status, ...r.body });
  }
  return out;
}

const meBalance = async (web: Web, key: string) => (await api(web.base, "/api/v1/me", { key })).body?.credits?.balanceMicroUsd as number;

// ---- wallet bridge (Node side of wallet-inject.js) ----

type WalletMode = "approve" | "reject" | "reject-connect" | "phantom";
type SentTx = { version: VersionedTransaction["version"]; programs: string[]; memo: string | null; feePayer: string; signature?: string; error?: string; rewritten: boolean };

class WalletBridge {
  mode: WalletMode = "approve";
  sent: SentTx[] = [];
  connects = 0;
  constructor(
    private chain: Chain,
    private rpcUrl: string,
  ) {}

  async handle(op: string, payload: string): Promise<string> {
    const p = JSON.parse(payload || "{}") as { tx?: string; options?: { preflightCommitment?: string } | null };
    if (op === "connect") {
      this.connects++;
      if (this.mode === "reject-connect") throw new Error("E2E_REJECT");
      return "ok";
    }
    if (op !== "signAndSend" && op !== "sign") throw new Error(`unsupported wallet op ${op}`);
    if (this.mode === "reject") throw new Error("E2E_REJECT");
    let tx = VersionedTransaction.deserialize(Buffer.from(p.tx!, "base64"));
    const rec = describeTx(tx);
    if (this.mode === "phantom") {
      tx = phantomize(tx, this.chain.wallet.publicKey);
      rec.rewritten = true;
      rec.programs = describeTx(tx).programs;
    }
    tx.sign([this.chain.wallet]);
    if (op === "sign") return Buffer.from(tx.serialize()).toString("base64");
    this.sent.push(rec);
    try {
      const conn = new Connection(this.rpcUrl, "confirmed");
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        preflightCommitment: (p.options?.preflightCommitment as "confirmed") ?? "confirmed",
      });
      rec.signature = sig;
      return Buffer.from(tx.signatures[0]!).toString("base64");
    } catch (err) {
      rec.error = walletErrorText(err);
      throw new Error(rec.error);
    }
  }
}

/**
 * What the wallet tells the dApp when the RPC refuses a transaction, the way wallets surface it: web3.js's message
 * without its multi-line " Logs: [...]" dump, plus the program's own reason from those logs. Without the reason a
 * token-program failure reads only "custom program error: 0x1", e.g. for a burn over the balance:
 *   "... Error processing Instruction 0: custom program error: 0x1. Error: insufficient funds."
 */
function walletErrorText(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").replace(/ Logs: .*$/, "").trim();
  const logs = err instanceof SendTransactionError ? (err.logs ?? []) : [];
  const reason = logs.filter((l) => /^Program log: Error: /.test(l)).pop()?.replace(/^Program log: /, "").replace(/\.$/, "");
  return (reason && !msg.includes(reason) ? `${msg} ${reason}.` : msg).slice(0, 300);
}

function describeTx(tx: VersionedTransaction): SentTx {
  const keys = tx.message.staticAccountKeys;
  const ixs = tx.message.compiledInstructions;
  const memoIx = ixs.find((ix) => keys[ix.programIdIndex]!.equals(MEMO_V2));
  return {
    version: tx.version,
    programs: ixs.map((ix) => keys[ix.programIdIndex]!.toBase58()),
    memo: memoIx ? Buffer.from(memoIx.data).toString("utf8") : null,
    feePayer: keys[0]!.toBase58(),
    rewritten: false,
  };
}

/** What Phantom-style wallets do before signing: prepend ComputeBudget limit + price, append a guard-like no-op. */
function phantomize(tx: VersionedTransaction, owner: PublicKey): VersionedTransaction {
  const msg = TransactionMessage.decompile(tx.message);
  msg.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25_000 }),
    ...msg.instructions,
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 0 }),
  ];
  return new VersionedTransaction(tx.version === "legacy" ? msg.compileToLegacyMessage() : msg.compileToV0Message());
}

// ---- browser helpers (page code is passed as strings so no transpiler helper leaks into the page) ----

/** Page-side RegExp. Always case-insensitive: badges, labels and stats are CSS-uppercased and innerText reflects that. */
const re = (r: RegExp) => `new RegExp(${JSON.stringify(r.source)}, ${JSON.stringify(r.flags.includes("i") ? r.flags : `${r.flags}i`)})`;
const BURN_PANEL = `document.querySelector('section[aria-labelledby="burn-h"]')`;

async function handle(page: Page, js: string): Promise<ElementHandle<Element> | null> {
  const h = await page.evaluateHandle(js);
  const e = h.asElement();
  if (!e) {
    await h.dispose();
    return null;
  }
  return e as ElementHandle<Element>;
}
const buttonJs = (r: RegExp, scope = "document") =>
  `(() => { const s = ${scope}; if (!s) return null; const r = ${re(r)}; return Array.from(s.querySelectorAll('button')).find((b) => r.test(b.innerText.trim())) || null; })()`;

async function button(page: Page, r: RegExp, scope = "document"): Promise<{ found: boolean; disabled: boolean; text: string }> {
  return page.evaluate(
    `(() => { const b = ${buttonJs(r, scope)}; return b ? { found: true, disabled: b.disabled || !!b.closest('fieldset:disabled'), text: b.innerText.trim() } : { found: false, disabled: true, text: '' }; })()`,
  ) as Promise<{ found: boolean; disabled: boolean; text: string }>;
}
/**
 * Scroll to the middle of the viewport first: the site's sticky header would otherwise take clicks near the top edge.
 * The scroll is instant (globals.css sets scroll-behavior: smooth), and the click waits until the element's box has
 * held still for a frame (web fonts, late layout), then checks nothing covers its center. Puppeteer clicks at fixed
 * coordinates, so a click computed while the element moves lands beside it, and that only shows up later as a
 * timeout. Throws, naming the covering element, instead.
 */
async function centerClick(page: Page, el: ElementHandle<Element>, count = 1): Promise<void> {
  const covered = await el.evaluate(async (e) => {
    e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await document.fonts.ready;
    let prev = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const b = e.getBoundingClientRect();
      const now = `${b.x},${b.y},${b.width},${b.height}`;
      if (now === prev) break;
      prev = now;
    }
    const b = e.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    if (!top || e.contains(top) || e.closest("label")?.contains(top)) return "";
    return `<${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}${top.className && typeof top.className === "string" ? `.${top.className.trim().split(/\s+/).join(".")}` : ""}> "${(top.textContent ?? "").trim().slice(0, 40)}"`;
  });
  if (covered) throw new Error(`click target is covered at its center by ${covered}`);
  await el.click({ count });
}
async function click(page: Page, r: RegExp, scope = "document"): Promise<void> {
  const b = await handle(page, buttonJs(r, scope));
  if (!b) throw new Error(`no button matching ${r}`);
  await centerClick(page, b);
  await b.dispose();
}
async function text(page: Page, scope = "document.body"): Promise<string> {
  return page.evaluate(`(() => { const s = ${scope}; return s ? s.innerText : ''; })()`) as Promise<string>;
}
async function waitText(page: Page, r: RegExp, timeoutMs: number, scope = "document.body"): Promise<string> {
  await page.waitForFunction(`(() => { const s = ${scope}; return !!s && ${re(r)}.test(s.innerText); })()`, { timeout: timeoutMs, polling: 250 });
  return text(page, scope);
}
async function shot(page: Page, name: string): Promise<string> {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const el = await page.waitForSelector(selector, { timeout: 15_000 });
  await centerClick(page, el!, 3);
  await page.keyboard.press("Backspace");
  if (value) await el!.type(value, { delay: 5 });
  await el!.dispose();
}
const AMOUNT = `section[aria-labelledby="burn-h"] input[inputmode="decimal"]`;
async function setAmount(page: Page, value: string): Promise<{ panel: string; burn: { found: boolean; disabled: boolean; text: string } }> {
  await typeInto(page, AMOUNT, value);
  await sleep(200);
  return { panel: await text(page, BURN_PANEL), burn: await button(page, /^(Burn|Preparing|Approve)/, BURN_PANEL) };
}

/** The burn status block text once it leaves "Verifying"/"Finalizing": the final credited/review/error state. */
const OUTCOME =
  /credit added\.|already credited|held for review|Over the per-burn limit|Cancelled|The wallet didn't send it|Still not credited|Verification failed|Memo missing|Wrong token|No burn found|Can't price|Transaction failed|Unknown workspace|Amounts don't add up|Not a signature|Couldn't build|Nothing was sent/;
async function waitBurnOutcome(page: Page, timeoutMs = 180_000): Promise<string> {
  return waitText(page, OUTCOME, timeoutMs, BURN_PANEL);
}
/** Click, then wait (on every DOM mutation, set up before the click) until the previous outcome is gone. */
async function clickAndAwaitNewOutcome(page: Page, r: RegExp): Promise<void> {
  const gone = page.waitForFunction(`(() => { const s = ${BURN_PANEL}; return !s || !${re(OUTCOME)}.test(s.innerText); })()`, { polling: "mutation", timeout: 60_000 });
  await click(page, r, BURN_PANEL);
  await gone;
}

let lastPage: Page | null = null;
async function newAppPage(browser: Browser, bridge: WalletBridge, chain: Chain, consoleErrors: string[]): Promise<Page> {
  const page = await browser.newPage();
  lastPage = page;
  await page.setViewport({ width: 1280, height: 900 });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The verify poller's "not yet" answers (404 not_found, 409 not_finalized) are expected while a burn finalizes.
    if (/\/api\/burns\/verify/.test(m.location()?.url ?? "") && /status of (404|409)/.test(m.text())) return;
    consoleErrors.push(`${m.text().slice(0, 300)} @ ${m.location()?.url ?? "?"}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${errText(e)}`));
  await page.exposeFunction("__e2eWallet", (op: string, payload: string) => bridge.handle(op, payload));
  await page.evaluateOnNewDocument(
    `window.__E2E_WALLET__ = ${JSON.stringify({ name: "E2E Wallet", address: chain.wallet.publicKey.toBase58(), publicKey: Array.from(chain.wallet.publicKey.toBytes()) })};`,
  );
  await page.evaluateOnNewDocument(readFileSync(join(HERE, "wallet-inject.js"), "utf8"));
  return page;
}

// ---- scenarios ----

type Ws = { key: string; id: string; memo: string };

/** /app from a clean tab: create a workspace, read the one-time key, confirm, land on the dashboard. */
async function onboard(page: Page, web: Web, label: string, tag: string): Promise<Ws> {
  await page.goto(`${web.base}/app`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await waitText(page, /Create a workspace/, 180_000);
  await typeInto(page, `input[placeholder="e.g. work laptop"]`, label);
  await click(page, /^Create workspace$/);
  // A submit turns the button into a disabled "Creating…" at once. Still an idle "Create workspace" after 15 s
  // means the click never reached the form (a run once timed out here with no POST /api/workspaces in the server
  // log): say so, click once more, and keep it in the warnings. An error the form shows fails the run instead.
  if (!(await waitText(page, /Save your API key now/, 15_000).then(() => true, () => false))) {
    const alert = await text(page, `document.querySelector('form [role="alert"]')`);
    if (alert) throw new Error(`${tag}: creating the workspace failed: ${alert}`);
    const idle = await button(page, /^Create workspace$/);
    if (idle.found && !idle.disabled) {
      warn(`${tag}: the first "Create workspace" click did not submit the form; clicked again`);
      await click(page, /^Create workspace$/);
    }
    await waitText(page, /Save your API key now/, 60_000);
  }
  const kv = (await page.evaluate(
    `(() => { const o = {}; document.querySelectorAll('dt').forEach((dt) => { const c = dt.nextElementSibling && dt.nextElementSibling.querySelector('code'); if (c) o[dt.textContent.trim()] = c.textContent.trim(); }); return o; })()`,
  )) as Record<string, string>;
  const ws: Ws = { key: kv["API key"] ?? "", id: kv["Workspace ID"] ?? "", memo: kv["Burn memo"] ?? "" };
  check(`${tag}: key revealed once with workspace id and memo`, /^forkbomb_sk_[0-9A-Za-z]{32}$/.test(ws.key) && /^ws_/.test(ws.id) && ws.memo === `forkbomb:${ws.id}`, `${ws.id}, memo ${ws.memo}`);
  const gated = await button(page, /^Open dashboard$/);
  check(`${tag}: "Open dashboard" stays disabled until "I saved the key" is ticked`, gated.found && gated.disabled);
  await shot(page, `${tag}-01-key-reveal`);
  const box = await handle(page, `(() => { const l = Array.from(document.querySelectorAll('label')).find((x) => /I saved the key/.test(x.innerText)); return l ? l.querySelector('input') : null; })()`);
  await centerClick(page, box!);
  await click(page, /^Open dashboard$/);
  await waitText(page, /Credit balance/, 60_000);
  await waitText(page, /burns open/, 60_000, BURN_PANEL);
  const me = await api(web.base, "/api/v1/me", { key: ws.key });
  check(`${tag}: /api/v1/me accepts the revealed key, balance 0`, me.status === 200 && me.body.workspace?.id === ws.id && me.body.credits?.balanceMicroUsd === 0, `HTTP ${me.status}`);
  return ws;
}

async function connectWallet(page: Page, chain: Chain, bridge: WalletBridge, tag: string, uiBalance: RegExp): Promise<void> {
  await waitText(page, /E2E Wallet/, 30_000, BURN_PANEL);
  bridge.mode = "reject-connect";
  await click(page, /E2E Wallet/, BURN_PANEL);
  const declined = await waitText(page, /declined the connection|Disconnect/, 30_000, BURN_PANEL);
  check(`${tag}: wallet that declines connect shows a clean error`, /You declined the connection in your wallet\./.test(declined) && !/Disconnect/i.test(declined));
  bridge.mode = "approve";
  await click(page, /E2E Wallet/, BURN_PANEL);
  await waitText(page, /Disconnect/, 30_000, BURN_PANEL);
  const addr = chain.wallet.publicKey.toBase58();
  const panel = await waitText(page, uiBalance, 60_000, BURN_PANEL);
  check(`${tag}: connected wallet shows its address and token balance`, panel.includes(`${addr.slice(0, 4)}…${addr.slice(-4)}`) && uiBalance.test(panel), `${addr.slice(0, 4)}…${addr.slice(-4)}`);
}

/** Burn through the UI and wait for the outcome. Returns the outcome text and the wallet's record of the tx. */
async function burnViaUi(page: Page, bridge: WalletBridge, amount: string): Promise<{ outcome: string; tx: SentTx | undefined; buttonText: string }> {
  const before = bridge.sent.length;
  const st = await setAmount(page, amount);
  if (!st.burn.found || st.burn.disabled) throw new Error(`burn button not clickable for ${amount}: "${st.burn.text}" disabled=${st.burn.disabled}; panel: ${st.panel.slice(0, 400)}`);
  await clickAndAwaitNewOutcome(page, /^Burn /);
  const outcome = await waitBurnOutcome(page);
  return { outcome, tx: bridge.sent[before], buttonText: st.burn.text };
}

async function verifyDirect(web: Web, signature: string) {
  return api(web.base, "/api/burns/verify", { body: { signature } });
}

async function ledgerRow(web: Web, sig: string): Promise<Json | undefined> {
  const r = await api(web.base, "/api/ledger?limit=100");
  return (r.body.burns as Json[] | undefined)?.find((b) => b.signature === sig);
}

async function checkMainBurn(
  page: Page,
  browser: Browser,
  web: Web,
  bridge: WalletBridge,
  chain: Chain,
  ws: Ws,
  tag: string,
  programId: PublicKey,
  ata: PublicKey,
): Promise<string | null> {
  const expect = expectedCredit(MAIN_BURN);
  const tokBefore = await tokenBalance(chain, ata, programId);
  const st = await setAmount(page, MAIN_BURN);
  check(`${tag}: estimate shows ≈ $15.24 before burning`, /≈ \$15\.24 credit/.test(st.panel), st.panel.match(/≈[^\n]*/)?.[0] ?? "");
  const { outcome, tx, buttonText } = await burnViaUi(page, bridge, MAIN_BURN);
  check(`${tag}: burn button read "${buttonText}"`, buttonText === "Burn 1,234.5 $FORKBOMB");
  const expectedPrograms = [programId.toBase58(), MEMO_V2.toBase58()];
  check(
    `${tag}: dApp built exactly [burnChecked, memo v2], v0, owner pays`,
    !!tx && tx.version === 0 && JSON.stringify(tx.programs) === JSON.stringify(expectedPrograms) && tx.memo === ws.memo && tx.feePayer === chain.wallet.publicKey.toBase58(),
    tx ? `v${tx.version} [${tx.programs.map((p) => p.slice(0, 6)).join(", ")}] memo "${tx.memo}"` : "no tx",
  );
  const sig = tx?.signature ?? null;
  await shot(page, `${tag}-02-credited`);
  check(`${tag}: UI reaches the credited state`, /credited/i.test(outcome) && /Burned 1234\.5 at \$0\.01235: \$15\.24 credit added\./.test(outcome), outcome.match(/Burned[^\n]*/)?.[0] ?? outcome.slice(-200));
  if (!sig) return null;
  const bal = await meBalance(web, ws.key);
  check(`${tag}: /api/v1/me balance == floor(${MAIN_BURN} x ${PRICE_USD} x 1e6) = ${expect}`, bal === expect, `got ${bal}`);
  const tokAfter = await tokenBalance(chain, ata, programId);
  check(`${tag}: on-chain token balance fell by exactly ${MAIN_BURN}`, tokBefore - tokAfter === scaled(MAIN_BURN, DECIMALS), `${tokBefore} -> ${tokAfter}`);
  await page.waitForFunction(`/\\$15\\.24/.test((document.querySelector('[aria-label="Credit"]') || {}).innerText || '')`, { timeout: 40_000 }).catch(() => null);
  const stats = await text(page, `document.querySelector('[aria-label="Credit"]')`);
  check(`${tag}: dashboard credit balance updates to $15.24`, /Credit balance\s*\$15\.24/i.test(stats), stats.replace(/\s+/g, " ").slice(0, 80));

  const row = await ledgerRow(web, sig);
  check(
    `${tag}: /api/ledger lists the burn`,
    !!row && row.amountUi === "1234.5" && row.creditMicroUsd === expect && row.status === "credited" && row.owner === chain.wallet.publicKey.toBase58() && row.priceUsd === PRICE_USD && !("workspaceId" in row),
    row ? `amountUi ${row.amountUi}, credit ${row.creditMicroUsd}, usd ${row.usdValue}, price ${row.priceUsd}, status ${row.status}` : "missing",
  );
  const lp = await browser.newPage();
  await lp.setViewport({ width: 1280, height: 900 });
  await lp.goto(`${web.base}/burns`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const link = await lp.waitForSelector(`a[aria-label="Transaction ${sig} on Solscan"]`, { timeout: 60_000 }).catch(() => null);
  const rowText = link ? ((await lp.evaluate(`(() => { const a = document.querySelector('a[aria-label="Transaction ${sig} on Solscan"]'); const tr = a && a.closest('tr'); return tr ? tr.innerText : ''; })()`)) as string) : "";
  await shot(lp, `${tag}-03-burns-ledger`);
  check(`${tag}: /burns page shows the row (1,234 burned, $15.24 credit)`, !!link && /1,234/.test(rowText) && /\$15\.24/.test(rowText), rowText.replace(/\s+/g, " ").trim());
  await lp.close();

  // Replay: the same signature again credits nothing, via the API and via the UI's signature form.
  const again = await verifyDirect(web, sig);
  check(`${tag}: replay via POST /api/burns/verify -> already_credited`, again.status === 200 && again.body.burn?.status === "already_credited", `HTTP ${again.status} ${again.body.burn?.status ?? again.body.error?.code}`);
  await page.evaluate(`(() => { const d = document.querySelector('section[aria-labelledby="burn-h"] details'); if (d) d.open = true; })()`);
  await typeInto(page, `input[aria-label="Transaction signature"]`, sig);
  await clickAndAwaitNewOutcome(page, /^Verify$/);
  const replayUi = await waitBurnOutcome(page, 60_000);
  check(`${tag}: replay via the UI's signature form shows "already credited"`, /already credited/i.test(replayUi));
  const balReplay = await meBalance(web, ws.key);
  check(`${tag}: replay adds no credit`, balReplay === expect, `balance ${balReplay}`);
  return sig;
}

// ---- main ----

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(PRICE_FILE, PRICE_USD);
  log(`dApp burn e2e. Output: ${OUT}`);
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);

  const { rpcUrl, proc: validator } = await startValidator();
  log(`validator ${rpcUrl}${validator ? " (started by the harness)" : ""}`);
  const chain = await setupChain(rpcUrl);
  log(`wallet ${chain.wallet.publicKey.toBase58()} (throwaway, key in memory only)`);
  log(`classic mint ${chain.mints.classic.toBase58()}, Token-2022 mint ${chain.mints.t22.toBase58()}, ${MINT_UI} each`);

  const webDir = cloneWeb();
  log(`web copy ${webDir}`);
  const bridge = new WalletBridge(chain, rpcUrl);
  const consoleErrors: string[] = [];
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.E2E_HEADFUL ? false : true,
    userDataDir: join(OUT, "chrome-profile"),
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"],
  });

  let web: Web | null = null;
  try {
    // ======== classic SPL mint ========
    log(`\n== classic SPL Token mint ==`);
    web = await startWeb(webDir, chain, rpcUrl, chain.mints.classic, "classic");
    log(`web ${web.base} (log ${web.log})`);
    const samples = await samplePrice(web, 2);
    check("classic: cron samples the stubbed price", samples.every((s) => s.status === 200 && s.sample?.priceUsd === PRICE_USD), samples.map((s) => `${s.status} ${s.sample?.priceUsd ?? s.error}`).join(", "));
    const badCron = await api(web.base, "/api/cron/price", { method: "POST", auth: "Bearer wrong" });
    check("classic: cron refuses a wrong secret", badCron.status === 401, `HTTP ${badCron.status}`);
    const price = await api(web.base, "/api/price");
    check("classic: /api/price has latest and TWAP", price.body.latest?.priceUsd === PRICE_USD && price.body.twap?.samples >= 2, JSON.stringify(price.body.twap));
    const tok = await api(web.base, "/api/token");
    check(
      "classic: /api/token reports burns open",
      tok.body.burnsOpen === true && tok.body.mint === chain.mints.classic.toBase58() && tok.body.program === "token" && tok.body.decimals === 6 && tok.body.memoPrefix === "forkbomb:" && tok.body.maxCreditPerBurnUsd === REVIEW_CAP_USD,
      `burnsOpen ${tok.body.burnsOpen}, program ${tok.body.program}, decimals ${tok.body.decimals}, cluster ${tok.body.cluster}, cap ${tok.body.maxCreditPerBurnUsd}`,
    );

    const page = await newAppPage(browser, bridge, chain, consoleErrors);
    const ws = await onboard(page, web, "e2e classic", "classic");
    await connectWallet(page, chain, bridge, "classic", /1,000,000/);

    // Amount edge cases: what the UI says and whether the burn button can be pressed.
    const cases: { input: string; expect: RegExp; enabled: boolean; label?: string }[] = [
      { input: "0", expect: /Amount must be more than zero\./, enabled: false },
      { input: "-5", expect: /Use digits and one dot, like 1500 or 12\.5\./, enabled: false },
      { input: "1.1234567", expect: /At most 6 decimal places\./, enabled: false },
      { input: "1,234.5", expect: /Use digits and one dot/, enabled: false },
      { input: "1e3", expect: /Use digits and one dot/, enabled: false },
      { input: "12..5", expect: /Use digits and one dot/, enabled: false },
      { input: "0.0000001", expect: /At most 6 decimal places\./, enabled: false },
      { input: "99999999999999999999", expect: /That amount is too large\./, enabled: false },
      { input: "18446744073709.551615", expect: /more than this wallet holds/, enabled: false },
      { input: "1000001", expect: /more than this wallet holds/, enabled: false },
      { input: " 12.5 ", expect: /≈ \$0\.15 credit/, enabled: true, label: "Burn 12.5 $FORKBOMB" },
      { input: ".5", expect: /≈ <\$0\.01 credit/, enabled: true, label: "Burn 0.5 $FORKBOMB" },
      { input: "5.", expect: /≈ \$0\.06 credit/, enabled: true, label: "Burn 5 $FORKBOMB" },
      { input: "0.000001", expect: /Too small to earn credit/, enabled: false },
    ];
    for (const c of cases) {
      const st = await setAmount(page, c.input);
      const ok = c.expect.test(st.panel) && st.burn.disabled === !c.enabled && (!c.label || st.burn.text === c.label);
      check(`classic: amount ${JSON.stringify(c.input)} -> ${c.enabled ? "allowed" : "blocked"}`, ok, `${st.panel.match(c.expect)?.[0] ?? "message missing"}; button "${st.burn.text}" ${st.burn.disabled ? "disabled" : "enabled"}`);
    }
    await setAmount(page, "1000001");
    await shot(page, "classic-00-over-balance");
    await setAmount(page, "");
    await click(page, /^Max$/, BURN_PANEL);
    const maxVal = (await page.evaluate(`document.querySelector(${JSON.stringify(AMOUNT)}).value`)) as string;
    check("classic: Max fills the exact wallet balance", maxVal === "1000000", `input "${maxVal}"`);
    await setAmount(page, "");

    // Main burn.
    await samplePrice(web);
    const mainSig = await checkMainBurn(page, browser, web, bridge, chain, ws, "classic", TOKEN_PROGRAM_ID, chain.atas.classic);
    let expectBal = expectedCredit(MAIN_BURN);

    // Wallet rejects signing.
    bridge.mode = "reject";
    const sentBefore = bridge.sent.length;
    const tokBeforeReject = await tokenBalance(chain, chain.atas.classic, TOKEN_PROGRAM_ID);
    const rej = await burnViaUi(page, bridge, "10");
    await shot(page, "classic-04-rejected");
    const tokAfterReject = await tokenBalance(chain, chain.atas.classic, TOKEN_PROGRAM_ID);
    check(
      "classic: wallet rejection -> clean 'Cancelled' error, nothing sent, no credit",
      /Cancelled/i.test(rej.outcome) && /You declined in your wallet\. Nothing was burned\./.test(rej.outcome) && bridge.sent.length === sentBefore && tokAfterReject === tokBeforeReject && (await meBalance(web, ws.key)) === expectBal,
      rej.outcome.match(/Cancelled[^\n]*\n?[^\n]*/i)?.[0]?.replace(/\n/g, " ") ?? rej.outcome.slice(-160),
    );
    bridge.mode = "approve";

    // Over the review cap: held, nothing credited.
    await samplePrice(web);
    const capSt = await setAmount(page, REVIEW_BURN);
    check("classic: over-cap amount warns before burning", /held for a manual review/.test(capSt.panel) && !capSt.burn.disabled, capSt.panel.match(/Burns worth more than[^\n]*/)?.[0] ?? "");
    const rev = await burnViaUi(page, bridge, REVIEW_BURN);
    await shot(page, "classic-05-review");
    const revSig = rev.tx?.signature;
    check("classic: over-cap burn lands in review in the UI", /held for review/i.test(rev.outcome) && /Over the per-burn limit/.test(rev.outcome), rev.outcome.match(/Burned[^\n]*/)?.[0] ?? rev.outcome.slice(-200));
    if (revSig) {
      const rv = await verifyDirect(web, revSig);
      check("classic: review burn: verify answers 202 review, recorded value, no credit", rv.status === 202 && rv.body.burn?.status === "review" && rv.body.burn?.creditMicroUsd === expectedCredit(REVIEW_BURN), `HTTP ${rv.status} ${rv.body.burn?.status} usd ${rv.body.burn?.usdValue}`);
      check("classic: review burn adds no credit", (await meBalance(web, ws.key)) === expectBal);
      const row = await ledgerRow(web, revSig);
      check("classic: review burn shows in ledger as review", row?.status === "review", row ? `status ${row.status}` : "missing");
    }

    // Phantom-shaped: the wallet adds 2 ComputeBudget instructions and a System no-op before signing.
    await samplePrice(web);
    bridge.mode = "phantom";
    const ph = await burnViaUi(page, bridge, PHANTOM_BURN);
    bridge.mode = "approve";
    await shot(page, "classic-06-phantom-shaped");
    const phPrograms = ph.tx?.programs ?? [];
    check(
      "classic: wallet-modified tx is [CB, CB, burnChecked, memo, System no-op]",
      JSON.stringify(phPrograms) === JSON.stringify([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN_PROGRAM_ID.toBase58(), MEMO_V2.toBase58(), SystemProgram.programId.toBase58()]),
      phPrograms.map((p) => p.slice(0, 6)).join(", "),
    );
    check("classic: Phantom-shaped burn credits", /credit added/.test(ph.outcome) && /\$1\.23 credit added/.test(ph.outcome), ph.outcome.match(/Burned[^\n]*/)?.[0] ?? ph.outcome.slice(-200));
    expectBal += expectedCredit(PHANTOM_BURN);
    check(`classic: balance += ${expectedCredit(PHANTOM_BURN)}`, (await meBalance(web, ws.key)) === expectBal, `balance ${await meBalance(web, ws.key)}, expected ${expectBal}`);

    // A wallet that only takes legacy transactions: the dApp must build a legacy [burnChecked, memo] (txVersionFor).
    await samplePrice(web);
    await page.evaluate(`window.__E2E_TX_VERSIONS = ["legacy"]`);
    const lg = await burnViaUi(page, bridge, LEGACY_BURN);
    await page.evaluate(`delete window.__E2E_TX_VERSIONS`);
    await shot(page, "classic-06b-legacy-only-wallet");
    check(
      "classic: legacy-only wallet gets a legacy [burnChecked, memo v2] tx",
      lg.tx?.version === "legacy" && JSON.stringify(lg.tx.programs) === JSON.stringify([TOKEN_PROGRAM_ID.toBase58(), MEMO_V2.toBase58()]) && lg.tx.memo === ws.memo,
      lg.tx ? `${lg.tx.version} [${lg.tx.programs.map((p) => p.slice(0, 6)).join(", ")}]` : "no tx",
    );
    expectBal += expectedCredit(LEGACY_BURN);
    const lgBal = await meBalance(web, ws.key);
    check(`classic: legacy burn credits (+${expectedCredit(LEGACY_BURN)})`, /credit added/.test(lg.outcome) && lgBal === expectBal, `${lg.outcome.match(/Burned[^\n]*/)?.[0] ?? lg.outcome.slice(-160)}; balance ${lgBal}, expected ${expectBal}`);

    // Hand-built: CB x2, an unrelated memo v1, burnChecked, our memo, an idempotent ATA create. Verified by signature in the UI.
    await samplePrice(web);
    const direct = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      new TransactionInstruction({ programId: MEMO_V1, keys: [], data: Buffer.from("gm from a guard", "utf8") }),
      createBurnCheckedInstruction(chain.atas.classic, chain.mints.classic, chain.wallet.publicKey, scaled(DIRECT_BURN, DECIMALS), DECIMALS, [], TOKEN_PROGRAM_ID),
      new TransactionInstruction({ programId: MEMO_V2, keys: [{ pubkey: chain.wallet.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(ws.memo, "utf8") }),
      createAssociatedTokenAccountIdempotentInstruction(chain.wallet.publicKey, chain.atas.classic, chain.wallet.publicKey, chain.mints.classic, TOKEN_PROGRAM_ID),
    );
    const directSig = await sendAndConfirmTransaction(chain.conn, direct, [chain.wallet], { commitment: "confirmed" });
    await page.evaluate(`(() => { const d = document.querySelector('section[aria-labelledby="burn-h"] details'); if (d) d.open = true; })()`);
    await typeInto(page, `input[aria-label="Transaction signature"]`, directSig);
    await clickAndAwaitNewOutcome(page, /^Verify$/);
    const dOut = await waitBurnOutcome(page);
    await shot(page, "classic-07-direct-built");
    check("classic: hand-built tx (CB x2 + memo v1 + burn + memo + ATA no-op) credits via the signature form", /\$0\.96 credit added/.test(dOut), dOut.match(/Burned[^\n]*/)?.[0] ?? dOut.slice(-200));
    expectBal += expectedCredit(DIRECT_BURN);
    check(`classic: balance += ${expectedCredit(DIRECT_BURN)}`, (await meBalance(web, ws.key)) === expectBal, `balance ${await meBalance(web, ws.key)}, expected ${expectBal}`);

    // Stale balance: the wallet moves tokens away after the page read its balance, then the user burns more than is left.
    await click(page, /^Refresh$/, BURN_PANEL);
    await sleep(1_500);
    const have = await tokenBalance(chain, chain.atas.classic, TOKEN_PROGRAM_ID);
    const sink = await getOrCreateAssociatedTokenAccount(chain.conn, chain.operator, chain.mints.classic, chain.operator.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
    await sendAndConfirmTransaction(
      chain.conn,
      new Transaction().add(createTransferCheckedInstruction(chain.atas.classic, chain.mints.classic, sink.address, chain.wallet.publicKey, have - UNIT, DECIMALS, [], TOKEN_PROGRAM_ID)),
      [chain.wallet],
      { commitment: "confirmed" },
    );
    const sentBeforeStale = bridge.sent.length;
    const stale = await burnViaUi(page, bridge, STALE_BURN);
    await shot(page, "classic-08-stale-balance");
    check(
      "classic: burning more than the on-chain balance (stale UI) errors clearly, nothing burned",
      /Not enough tokens/i.test(stale.outcome) && /Your wallet holds less than this now/.test(stale.outcome) && /Nothing was sent\./.test(stale.outcome) && !stale.tx?.signature && bridge.sent.length === sentBeforeStale,
      stale.outcome.match(/Not enough tokens[\s\S]*?Nothing was sent\./i)?.[0]?.replace(/\s+/g, " ").slice(0, 260) ?? stale.outcome.slice(-200),
    );
    await click(page, /^Refresh$/, BURN_PANEL);
    const after = await waitFor("refreshed balance", async () => {
      const st = await setAmount(page, STALE_BURN);
      return /more than this wallet holds/.test(st.panel) ? st : null;
    }, 20_000, 1_000).catch(() => ({ panel: "", burn: { found: false, disabled: false, text: "" } }));
    check("classic: after Refresh the UI blocks the over-balance amount", /more than this wallet holds/.test(after.panel) && after.burn.disabled);
    check("classic: no credit from the failed burn", (await meBalance(web, ws.key)) === expectBal);

    const ledger = await api(web.base, "/api/ledger");
    check(
      "classic: ledger totals: 5 burns, credited total excludes the review burn",
      ledger.body.totals?.burns === 5 && ledger.body.totals?.creditedMicroUsd === expectBal,
      JSON.stringify(ledger.body.totals),
    );
    log(`  main burn ${mainSig}`);

    await page.close();
    await stopAndWait(web.proc);
    web = null;

    // ======== Token-2022 mint ========
    log(`\n== Token-2022 mint ==`);
    // Fresh server, the cron never runs before this burn, and both price sources start out down.
    writeFileSync(PRICE_FILE, "down");
    web = await startWeb(webDir, chain, rpcUrl, chain.mints.t22, "t22");
    log(`web ${web.base} (log ${web.log})`);
    const tok2 = await api(web.base, "/api/token");
    check("t22: /api/token reports burns open, program token-2022", tok2.body.burnsOpen === true && tok2.body.program === "token-2022" && tok2.body.mint === chain.mints.t22.toBase58(), `${tok2.body.program}, burnsOpen ${tok2.body.burnsOpen}`);
    const cronDown = (await samplePrice(web))[0]!;
    check("t22: cron with both price sources down answers 502 and stores nothing", cronDown.status === 502 && cronDown.sample === null, `${cronDown.status} ${cronDown.error}`);
    const priceDown = await api(web.base, "/api/price");
    check("t22: /api/price with sources down still answers 200, no sample", priceDown.status === 200 && priceDown.body.latest === null, `HTTP ${priceDown.status} latest ${JSON.stringify(priceDown.body.latest)}`);
    const page2 = await newAppPage(browser, bridge, chain, consoleErrors);
    const ws2 = await onboard(page2, web, "e2e token-2022", "t22");
    await connectWallet(page2, chain, bridge, "t22", /1,000,000/);

    const noPrice = await setAmount(page2, MAIN_BURN);
    await shot(page2, "t22-00-no-price");
    check(
      "t22: with no price sample the UI pauses burning",
      /hasn't sampled in the last 25 minutes/.test(noPrice.panel) && noPrice.burn.disabled,
      `${noPrice.panel.match(/The price feed[^\n]*/)?.[0] ?? "message missing"}; button ${noPrice.burn.disabled ? "disabled" : "enabled"}`,
    );
    // The feed recovers. No cron call: the panel's own once-a-minute /api/price read must take the sample.
    writeFileSync(PRICE_FILE, PRICE_USD);
    const reopened = await waitText(page2, /≈ \$15\.24 credit/, 90_000, BURN_PANEL).then(() => true, () => false);
    const reopenedAt = Date.now();
    const settling = /Burning unlocks in a few seconds/.test(await text(page2, BURN_PANEL));
    const unlocked = await waitFor("burn button enabled", async () => ((await button(page2, /^Burn /, BURN_PANEL)).disabled ? null : true), 20_000, 250).then(() => true, () => false);
    log(`  [qa] estimate appeared; settle notice shown: ${settling}; button enabled after ${Date.now() - reopenedAt} ms`);
    check("t22: burning reopens on its own: the panel's /api/price read samples on demand (no cron, no reload)", reopened && unlocked && !/Burning unlocks/.test(await text(page2, BURN_PANEL)));
    const onDemand = await api(web.base, "/api/price");
    check(
      "t22: exactly one sample exists, taken on demand",
      onDemand.body.latest?.priceUsd === PRICE_USD && onDemand.body.latest?.source === "jupiter" && onDemand.body.twap?.samples === 1,
      `latest ${onDemand.body.latest?.priceUsd} (${onDemand.body.latest?.source}), window samples ${onDemand.body.twap?.samples}`,
    );

    // The main burn, priced from that single on-demand sample: the production path while the scheduler is silent.
    await checkMainBurn(page2, browser, web, bridge, chain, ws2, "t22", TOKEN_2022_PROGRAM_ID, chain.atas.t22);

    // Reload while the burn is finalizing: the pending signature (localStorage) resumes verifying, no wallet needed.
    await samplePrice(web);
    const sentAt = bridge.sent.length;
    await setAmount(page2, RELOAD_BURN);
    await clickAndAwaitNewOutcome(page2, /^Burn /);
    const reloadSig = await waitFor("burn sent", async () => bridge.sent[sentAt]?.signature ?? null, 60_000, 100);
    await page2.waitForFunction(`(localStorage.getItem('forkbomb.pendingBurns') || '').includes(${JSON.stringify(reloadSig)})`, { timeout: 30_000 });
    const stillVerifying = /Verifying|Finalizing|Waiting for the transaction/i.test(await text(page2, BURN_PANEL));
    await page2.reload({ waitUntil: "domcontentloaded" });
    const resumed = await waitBurnOutcome(page2);
    await shot(page2, "t22-04-resumed-after-reload");
    check(
      "t22: reload mid-verification resumes and credits",
      stillVerifying && /\$0\.12 credit added/.test(resumed),
      resumed.match(/Burned[^\n]*/)?.[0] ?? resumed.slice(-200),
    );
    const t22Bal = await meBalance(web, ws2.key);
    check(`t22: final balance == ${expectedCredit(MAIN_BURN)} + ${expectedCredit(RELOAD_BURN)}`, t22Bal === expectedCredit(MAIN_BURN) + expectedCredit(RELOAD_BURN), `balance ${t22Bal}`);
    const pendingLeft = (await page2.evaluate(`localStorage.getItem('forkbomb.pendingBurns') || '[]'`)) as string;
    check("t22: pending list is empty after crediting", !pendingLeft.includes(reloadSig), pendingLeft);
    await page2.close();
  } catch (err) {
    if (lastPage && !lastPage.isClosed()) {
      const p = await shot(lastPage, "failure").catch(() => "");
      const t = await text(lastPage).catch(() => "");
      log(`\nunexpected error; screenshot ${p}\npage text (tail): ${t.slice(-1200)}`);
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
    if (web) await stopAndWait(web.proc);
    if (validator) await stopAndWait(validator);
  }

  const relevant = consoleErrors.filter((e) => !/favicon|Download the React DevTools|\[Fast Refresh\]|HMR/i.test(e));
  if (relevant.length) {
    log(`\nbrowser console errors (${relevant.length}):`);
    for (const e of [...new Set(relevant)].slice(0, 15)) log(`  ${e}`);
  }
  const failed = checks.filter((c) => !c.ok);
  log(`\n${failed.length ? "FAIL" : "PASS"}: ${checks.length - failed.length}/${checks.length} checks passed. Output: ${OUT}`);
  for (const c of failed) log(`  failed: ${c.name}  ${c.detail}`);
  for (const w of warnings) log(`  warning: ${w}`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ checks, warnings, consoleErrors: relevant, sent: bridge.sent }, null, 2));
  return failed.length ? 1 : 0;
}

process.exitCode = await main().catch((err: unknown) => {
  console.error("FAIL: unexpected error:", err instanceof Error ? (err.stack ?? err.message) : err);
  return 1;
});
cleanupAll();
if (process.env.E2E_KEEP_OUT !== "1" && !process.env.E2E_OUT_DIR) {
  // Keep screenshots and logs; drop the bulky web clone and validator ledger.
  for (const d of ["web", "ledger", "chrome-profile"]) rmSync(join(OUT, d), { recursive: true, force: true });
}
