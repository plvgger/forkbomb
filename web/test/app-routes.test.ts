import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as rpcRoute } from "../app/api/rpc/route";
import { RPC_MAX_BODY_BYTES, RPC_MAX_RESPONSE_BYTES } from "../app/api/rpc/proxy";
import { GET as tokenRoute } from "../app/api/token/route";
import { resetTokenCache, TOKEN_CACHE_MS, tokenInfo } from "../app/api/token/token";
import { GET as usageRoute } from "../app/api/v1/usage/route";
import { credit, reserve, settle } from "../lib/server/credits";
import type { Db } from "../lib/server/db";
import { MINT } from "./fixtures/transactions";
import { freshDb, newWorkspace, RPC_URL } from "./helpers";

const BASE = "https://site.test";
let db: Db;
let rpcCalls: { method: string; params: unknown[] }[];
let rpcAnswer: (method: string, params: unknown[]) => Response;

const ok = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });

const rpcPost = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("SOLANA_RPC_URL", RPC_URL);
  resetTokenCache();
  rpcCalls = [];
  rpcAnswer = () => ok(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== RPC_URL) throw new Error(`unexpected fetch in test: ${url}`);
      const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      rpcCalls.push(req);
      return rpcAnswer(req.method, req.params);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.close();
});

describe("POST /api/rpc", () => {
  it("forwards an allowlisted call and keeps the caller's id", async () => {
    rpcAnswer = () => ok({ context: { slot: 9 }, value: 42 });
    const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: "abc", method: "getBalance", params: ["Owner1111"] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: "abc", result: { context: { slot: 9 }, value: 42 } });
    expect(rpcCalls).toEqual([{ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["Owner1111"] }]);
  });

  it("passes RPC errors through as JSON-RPC errors", async () => {
    rpcAnswer = () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param" } }));
    const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 7, method: "getBalance", params: ["x"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "Invalid param" } });
  });

  it("rejects every method off the allowlist without calling the RPC", async () => {
    for (const method of ["sendTransaction", "getTransaction", "requestAirdrop", "getProgramAccounts", "getAccountInfo", "getbalance", ""]) {
      const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method, params: [] }));
      expect(res.status, method).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "method_not_allowed" } });
    }
    expect(rpcCalls).toEqual([]);
  });

  it("reads token accounts only for TOKEN_MINT", async () => {
    const call = (filter: unknown) =>
      rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: ["Owner1111", filter, { encoding: "jsonParsed" }] }));
    vi.stubEnv("TOKEN_MINT", "");
    expect((await call({ mint: MINT })).status).toBe(403); // before launch there is nothing to read
    vi.stubEnv("TOKEN_MINT", MINT);
    for (const filter of [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { programId: TOKEN_2022_PROGRAM_ADDRESS }, { mint: MINT, x: 1 }, null, [MINT]]) {
      const res = await call(filter);
      expect(res.status, JSON.stringify(filter)).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "mint_not_allowed" } });
    }
    expect(rpcCalls).toEqual([]);
    rpcAnswer = () => ok({ value: [] });
    expect((await call({ mint: MINT })).status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
  });

  it("drops an upstream answer over the byte cap, counting bytes not characters", async () => {
    // Multi-byte characters: under the cap in string length, over it in bytes. No content-length, so it streams.
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: "é".repeat(RPC_MAX_RESPONSE_BYTES / 2 + 10) } });
    expect(huge.length).toBeLessThan(RPC_MAX_RESPONSE_BYTES);
    rpcAnswer = () => new Response(new Blob([huge]).stream());
    const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["o"] }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "rpc_response_too_large" } });
  });

  it("rejects batches, bad envelopes and too many signatures", async () => {
    const bad = [
      [{ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] }],
      { id: 1, method: "getBalance", params: [] },
      { jsonrpc: "2.0", id: 1, method: "getBalance", params: "x" },
      { jsonrpc: "2.0", id: { a: 1 }, method: "getBalance", params: [] },
      { jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [Array.from({ length: 17 }, () => "s")] },
      "{not json",
    ];
    for (const body of bad) expect((await rpcRoute(rpcPost(body))).status, JSON.stringify(body)).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("rejects oversized bodies", async () => {
    const big = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x".repeat(RPC_MAX_BODY_BYTES)] };
    const res = await rpcRoute(rpcPost(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "body_too_large" } });
    const declared = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getBalance" }, { "content-length": "999999" }));
    expect(declared.status).toBe(413);
    expect(rpcCalls).toEqual([]);
  });

  it("rate limits per IP", async () => {
    vi.stubEnv("RATE_RPC_PER_MINUTE", "2");
    rpcAnswer = () => ok({ value: 1 });
    const call = (ip: string) => rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["o"] }, { "x-forwarded-for": ip }));
    expect((await call("198.51.100.1")).status).toBe(200);
    expect((await call("198.51.100.1")).status).toBe(200);
    const limited = await call("198.51.100.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await call("198.51.100.2")).status).toBe(200);
  });

  // Regression: a text/plain POST is a CORS "simple request", so any site could make its visitors' browsers spend
  // the shared RPC quota without a preflight.
  it("serves only this site's pages: JSON content type, no cross-site fetch", async () => {
    rpcAnswer = () => ok({ value: 1 });
    const body = { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] };
    const plain = await rpcRoute(rpcPost(body, { "content-type": "text/plain" }));
    expect(plain.status).toBe(415);
    expect(await plain.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
    for (const site of ["cross-site", "same-site"]) {
      const res = await rpcRoute(rpcPost(body, { "sec-fetch-site": site }));
      expect(res.status, site).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "cross_site" } });
    }
    expect(rpcCalls).toEqual([]);
    expect((await rpcRoute(rpcPost(body, { "sec-fetch-site": "same-origin" }))).status).toBe(200);
    expect((await rpcRoute(rpcPost(body, { "content-type": "application/json; charset=utf-8" }))).status).toBe(200);
  });

  it("caps all callers together, whatever their IPs", async () => {
    vi.stubEnv("RATE_RPC_GLOBAL_PER_MINUTE", "3");
    rpcAnswer = () => ok({ value: 1 });
    const call = (ip: string) => rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["o"] }, { "x-forwarded-for": ip }));
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) expect((await call(ip)).status).toBe(200);
    expect((await call("198.51.100.4")).status).toBe(429);
  });

  it("forwards to SOLANA_PROXY_RPC_URL when set, keeping SOLANA_RPC_URL for verification", async () => {
    const proxyUrl = "https://proxy-rpc.test.invalid";
    vi.stubEnv("SOLANA_PROXY_RPC_URL", proxyUrl);
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        seen.push(String(input instanceof Request ? input.url : input));
        return ok({ value: 7 });
      }),
    );
    const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["o"] }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([proxyUrl]);
  });

  it("maps an unreachable RPC to 502", async () => {
    rpcAnswer = () => new Response("down", { status: 500 });
    const res = await rpcRoute(rpcPost({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] }));
    expect(res.status).toBe(502);
  });
});

describe("GET /api/token", () => {
  it("is closed with nulls when TOKEN_MINT is unset, and never calls the RPC", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    const res = await tokenRoute(new Request(`${BASE}/api/token`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticker: expect.any(String),
      mint: null,
      decimals: null,
      program: null,
      burnsOpen: false,
      memoPrefix: expect.stringMatching(/^[a-z0-9]+:$/),
      cluster: "mainnet",
      creditMultiplier: "1",
      maxCreditPerBurnUsd: "5000",
    });
    expect(rpcCalls).toEqual([]);
  });

  it("reads the mint's program and decimals, then caches for 5 minutes", async () => {
    vi.stubEnv("TOKEN_MINT", MINT);
    rpcAnswer = () =>
      ok({ value: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: { parsed: { type: "mint", info: { decimals: 6 } } } } });
    const t0 = Date.parse("2026-10-06T12:00:00Z");
    const info = await tokenInfo(t0);
    expect(info).toMatchObject({ mint: MINT, decimals: 6, program: "token-2022", burnsOpen: true });
    expect(rpcCalls[0]).toMatchObject({ method: "getAccountInfo", params: [MINT, { encoding: "jsonParsed" }] });
    await tokenInfo(t0 + TOKEN_CACHE_MS - 1);
    expect(rpcCalls).toHaveLength(1);
    await tokenInfo(t0 + TOKEN_CACHE_MS + 1);
    expect(rpcCalls).toHaveLength(2);
  });

  it("stays closed (and uncached) when the mint can't be read or isn't a token mint", async () => {
    vi.stubEnv("TOKEN_MINT", MINT);
    rpcAnswer = () => ok({ value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } });
    expect(await tokenInfo()).toMatchObject({ mint: MINT, program: null, decimals: null, burnsOpen: false });
    rpcAnswer = () => new Response("nope", { status: 503 });
    expect(await tokenInfo()).toMatchObject({ burnsOpen: false });
    expect(rpcCalls).toHaveLength(2);
  });

  it("reports devnet when the RPC is a devnet endpoint", async () => {
    vi.stubEnv("TOKEN_MINT", "");
    vi.stubEnv("SOLANA_RPC_URL", "https://api.devnet.solana.com");
    expect((await tokenInfo()).cluster).toBe("devnet");
  });
});

describe("GET /api/v1/usage", () => {
  const get = (key?: string, query = "") =>
    usageRoute(new Request(`${BASE}/api/v1/usage${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));

  it("requires a valid Bearer key", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("forkbomb_sk_00000000000000000000000000000000")).status).toBe(401);
    const res = await get("not-a-key");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns only this workspace's rows, newest first, with totals", async () => {
    const a = await newWorkspace("a");
    const b = await newWorkspace("b");
    await db.tx((q) => credit(q, a.id, 5_000_000, "grant", "a"));
    await db.tx((q) => credit(q, b.id, 5_000_000, "grant", "b"));
    const r1 = await reserve(a.id, 10_000);
    await settle(r1.id, 4_000, { model: "m1", inputTokens: 100, outputTokens: 50 });
    const r2 = await reserve(a.id, 10_000);
    await settle(r2.id, 6_000, { model: "m2", inputTokens: 200, outputTokens: 70 });
    const rb = await reserve(b.id, 10_000);
    await settle(rb.id, 9_000, { model: "other", inputTokens: 1, outputTokens: 1 });

    const res = await get(a.apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { usage: { model: string; costMicroUsd: number }[]; totals: unknown };
    expect(body.usage.map((u) => u.model)).toEqual(["forkbomb-hosted", "forkbomb-hosted"]); // never the upstream model
    expect(body.usage.map((u) => u.costMicroUsd)).toEqual([6_000, 4_000]);
    expect(body.totals).toEqual({
      requests: 2,
      inputTokens: 300,
      outputTokens: 120,
      costMicroUsd: 10_000,
      creditedMicroUsd: 5_000_000,
    });
    const one = (await (await get(a.apiKey, "?limit=1")).json()) as { usage: unknown[] };
    expect(one.usage).toHaveLength(1);
  });

  it("validates limit", async () => {
    const a = await newWorkspace();
    for (const q of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5"]) expect((await get(a.apiKey, q)).status).toBe(400);
  });
});
