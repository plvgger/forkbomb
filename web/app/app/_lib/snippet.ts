// Display helpers for the dashboard. Pure, so they're tested without a browser.

/** "forkbomb_sk_abcd…wxyz": enough to recognise the key, not enough to use it. */
export function maskKey(key: string): string {
  const i = key.indexOf("_sk_");
  const head = i >= 0 ? key.slice(0, i + 4) : "";
  const body = key.slice(head.length);
  return body.length <= 8 ? `${head}…` : `${head}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** The CLI setup lines. Pass the real key for the copied text and maskKey(key) for what the page shows. */
export function setupSnippet(key: string, hostedOrigin: string | null): string {
  return [
    `export FORKBOMB_API_KEY=${key}`,
    ...(hostedOrigin ? [`export FORKBOMB_HOSTED_URL=${hostedOrigin}/api/v1`] : []),
    `node dist/cli.js run ./repo --engine hosted \\`,
    `  --task "fix the failing tests" --test "npm test"`,
  ].join("\n");
}

/** Solscan link for a transaction on the right cluster. */
export function explorerTx(signature: string, cluster: "mainnet" | "devnet" | "testnet"): string {
  const base = `https://solscan.io/tx/${encodeURIComponent(signature)}`;
  return cluster === "mainnet" ? base : `${base}?cluster=${cluster}`;
}

export function explorerAccount(addr: string, cluster: "mainnet" | "devnet" | "testnet"): string {
  const base = `https://solscan.io/account/${encodeURIComponent(addr)}`;
  return cluster === "mainnet" ? base : `${base}?cluster=${cluster}`;
}
