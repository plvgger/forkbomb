import type { MetadataRoute } from "next";

// Draft until launch. Crawling is allowed on purpose: a crawler has to fetch a
// page to see its noindex (meta tag + X-Robots-Tag), and a Disallow would hide it.
// At launch: remove the noindex in app/layout.tsx and next.config.mjs, and add
// `sitemap: \`${SITE.url}/sitemap.xml\``.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
  };
}
