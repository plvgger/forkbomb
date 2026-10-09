/** @type {import('next').NextConfig} */

// Draft until launch: keep every response out of search indexes.
const noindex = { key: "X-Robots-Tag", value: "noindex, nofollow" };

// Baseline security headers. The replay iframe is same-origin, so SAMEORIGIN keeps it working.
const security = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const dev = process.env.NODE_ENV === "development";

// The full policy, report-only for now: browsers log what it would block and block nothing. Wallet extensions
// inject scripts into /app, so it moves into Content-Security-Policy only after a wallet burn on /app logs no
// violation. Inline scripts stay allowed (Next.js inlines its RSC payload; nonces would make every page dynamic);
// what it adds is that no script, frame or fetch can reach another origin. frame-ancestors is enforced above.
const cspReportOnly = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// /api/v1/* authenticates with a Bearer key and never with cookies, so any origin may call it: browser-based
// OpenAI clients need this. Authorization must be named (the "*" wildcard never covers it); "*" covers the
// x-stainless-* headers the OpenAI SDKs send. The credit headers are exposed so browser clients can read them.
const cors = [
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
  { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, *" },
  {
    key: "Access-Control-Expose-Headers",
    value: "x-credits-remaining-usd, x-request-cost-usd, x-credits-reserved-usd, x-request-id, retry-after",
  },
  { key: "Access-Control-Max-Age", value: "86400" },
];

export default {
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: [noindex, ...security, { key: "Content-Security-Policy-Report-Only", value: cspReportOnly }] },
      { source: "/api/v1/:path*", headers: cors },
    ];
  },
  async rewrites() {
    return [
      // Short, shareable URL for the full replay (a static app in public/replay).
      { source: "/replay", destination: "/replay/index.html" },
      // RFC 9116 location, generated from app/config.ts by app/security.txt/route.ts.
      { source: "/.well-known/security.txt", destination: "/security.txt" },
    ];
  },
};
