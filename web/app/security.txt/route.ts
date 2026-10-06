import { ADVISORY_URL, SITE } from "../config";

// RFC 9116 security.txt. Served at /security.txt and, via a rewrite in
// next.config.mjs, at /.well-known/security.txt. Built from app/config.ts.
export const dynamic = "force-static";

const EXPIRES = "2027-10-05T00:00:00.000Z"; // renew before this date

export function GET() {
  const body = [
    `Contact: ${ADVISORY_URL}`,
    `Expires: ${EXPIRES}`,
    "Preferred-Languages: en",
    `Policy: ${SITE.url}/security#disclosure`,
    `Canonical: ${SITE.url}/.well-known/security.txt`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
