// Launch gate: every external link the site depends on must resolve.
// Usage: npm run check:links   (honours NEXT_PUBLIC_GITHUB_URL like app/config.ts)
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../app/config.ts", import.meta.url), "utf8");
const fallback = config.match(/NEXT_PUBLIC_GITHUB_URL \|\| "([^"]+)"/)?.[1];
const repo = (process.env.NEXT_PUBLIC_GITHUB_URL || fallback || "").replace(/\/$/, "");
if (!repo) {
  console.error("check-links: could not read GITHUB_URL from app/config.ts");
  process.exit(1);
}

const urls = [repo, `${repo}/issues`, `${repo}/blob/main/LICENSE`, `${repo}/blob/main/src/sandbox.ts`, `${repo}/tree/main/test`];
let failed = 0;
for (const url of urls) {
  let status = 0;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    status = res.status;
  } catch (err) {
    status = -1;
  }
  const ok = status >= 200 && status < 300;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${status} ${url}`);
}
if (failed) {
  console.error(`\ncheck-links: ${failed} link(s) failed. Publish the repo or set NEXT_PUBLIC_GITHUB_URL before launch.`);
  process.exit(1);
}
