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

export default {
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [noindex, ...security] }];
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
