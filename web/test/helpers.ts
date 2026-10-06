// Shared test setup: a fresh migrated in-memory PGlite per test, and a fetch mock for RPC and price APIs.

import { vi } from "vitest";
import { burnMemo } from "../lib/server/workspaces";
import { openPglite, setDb, type Db } from "../lib/server/db";
import { migrate } from "../lib/server/migrate";
import { createWorkspace } from "../lib/server/workspaces";
import type { ParsedTransaction } from "../lib/server/burns";
import { MINT } from "./fixtures/transactions";

export const RPC_URL = "https://rpc.test.invalid";

/** Fresh database with all migrations, installed as the process-wide db. */
export async function freshDb(): Promise<Db> {
  const db = await openPglite();
  await migrate(db);
  setDb(db);
  return db;
}

export function useTokenEnv(overrides: Record<string, string> = {}) {
  vi.stubEnv("TOKEN_MINT", MINT);
  vi.stubEnv("SOLANA_RPC_URL", RPC_URL);
  for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

export async function newWorkspace(label = "test") {
  const { workspace, apiKey } = await createWorkspace({ label });
  return { ...workspace, apiKey, memo: burnMemo(workspace.id) };
}

export type FakeChain = {
  /** signature -> finalized transaction */
  txs: Map<string, ParsedTransaction>;
  /** signature -> status for getSignatureStatuses when the tx is not finalized */
  statuses: Map<string, { confirmationStatus: string; err: unknown }>;
  /** Live spot quotes; null makes that source fail. */
  jupiter: number | null;
  dexscreener: number | null;
  calls: { rpc: string[]; price: string[] };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stubs global fetch with an in-memory Solana RPC plus Jupiter and DexScreener. No network. */
export function fakeChain(): FakeChain {
  const chain: FakeChain = { txs: new Map(), statuses: new Map(), jupiter: null, dexscreener: null, calls: { rpc: [], price: [] } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === RPC_URL) {
        const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        chain.calls.rpc.push(req.method);
        // Real RPCs can be slow; yield so concurrent verifies interleave.
        await new Promise((r) => setTimeout(r, 5));
        if (req.method === "getTransaction") {
          return json({ jsonrpc: "2.0", id: 1, result: chain.txs.get(req.params[0] as string) ?? null });
        }
        if (req.method === "getSignatureStatuses") {
          const sig = (req.params[0] as string[])[0]!;
          return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [chain.statuses.get(sig) ?? null] } });
        }
        return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
      }
      if (url.startsWith("https://lite-api.jup.ag/price/v3")) {
        chain.calls.price.push("jupiter");
        if (chain.jupiter === null) return json({}, 200);
        return json({ [MINT]: { usdPrice: chain.jupiter, blockId: 1, decimals: 6, priceChange24h: 0 } });
      }
      if (url.startsWith("https://api.dexscreener.com/latest/dex/tokens/")) {
        chain.calls.price.push("dexscreener");
        if (chain.dexscreener === null) return json({ error: "down" }, 500);
        return json({
          schemaVersion: "1.0.0",
          pairs: [
            { chainId: "solana", baseToken: { address: MINT }, priceUsd: String(chain.dexscreener), liquidity: { usd: 90_000 } },
            { chainId: "solana", baseToken: { address: MINT }, priceUsd: "999", liquidity: { usd: 10 } },
          ],
        });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
  return chain;
}

/** Insert price samples directly: [msFromBase, priceUsd]. */
export async function seedSamples(db: Db, base: Date, points: [number, string][], mint = MINT) {
  for (const [offset, price] of points) {
    await db.query("INSERT INTO price_samples (mint, ts, price_usd, source) VALUES ($1, $2, $3, 'jupiter')", [
      mint,
      new Date(base.getTime() + offset).toISOString(),
      price,
    ]);
  }
}

export const MIN = 60_000;
