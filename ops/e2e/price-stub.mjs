// Price-source stub for the dApp e2e, preloaded into the web server process ONLY:
//   NODE_OPTIONS="--import /abs/path/ops/e2e/price-stub.mjs"
// Answers Jupiter (lite-api.jup.ag/price/v3) and DexScreener (api.dexscreener.com/latest/dex/tokens) for the
// mints in E2E_PRICE_MINTS (comma-separated) with E2E_PRICE_USD, the way those APIs shape their bodies.
// If E2E_PRICE_FILE is set and readable, its trimmed contents override E2E_PRICE_USD on every request,
// so a running server can be re-priced. The word "down" there makes both sources answer 503 for the test
// mints (a price-feed outage). Every other request goes to the real fetch untouched.

import { readFileSync } from "node:fs";

const mints = new Set(
  (process.env.E2E_PRICE_MINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const realFetch = globalThis.fetch;

function price() {
  const file = process.env.E2E_PRICE_FILE;
  if (file) {
    try {
      const v = readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {}
  }
  return (process.env.E2E_PRICE_USD || "").trim();
}

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const outage = () => reply({ error: "e2e price outage" }, 503);

if (mints.size && typeof realFetch === "function") {
  globalThis.fetch = async function e2ePriceStub(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch(input, init);
    }
    const p = price();
    if (p && url.hostname === "lite-api.jup.ag" && url.pathname.startsWith("/price/v3")) {
      const ids = (url.searchParams.get("ids") || "").split(",").filter((id) => mints.has(id));
      if (ids.length && p === "down") return outage();
      if (ids.length) {
        return reply(Object.fromEntries(ids.map((id) => [id, { usdPrice: Number(p), decimals: 6, priceChange24h: 0 }])));
      }
    }
    if (p && url.hostname === "api.dexscreener.com" && url.pathname.startsWith("/latest/dex/tokens/")) {
      const id = decodeURIComponent(url.pathname.slice("/latest/dex/tokens/".length));
      if (mints.has(id) && p === "down") return outage();
      if (mints.has(id)) {
        return reply({
          schemaVersion: "1.0.0",
          pairs: [{ chainId: "solana", dexId: "e2e", priceUsd: p, baseToken: { address: id }, liquidity: { usd: 1_000_000 } }],
        });
      }
    }
    return realFetch(input, init);
  };
  console.log(`[e2e price-stub] answering Jupiter/DexScreener for ${mints.size} mint(s)`);
}
