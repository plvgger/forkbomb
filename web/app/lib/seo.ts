import type { Metadata } from "next";
import { SITE } from "../config";
import { OG_ALT } from "../_og/meta";

/**
 * Per-page metadata: title (templated as "%s — Hydra"), description, canonical, OG, Twitter.
 * A page's own openGraph/twitter objects replace the root ones, so the card image is set
 * here explicitly. Routes with their own opengraph-image.tsx pass `image`.
 */
export function pageMetadata({
  title,
  description,
  path,
  image = "/opengraph-image",
  imageAlt = OG_ALT,
}: {
  /** Short page title, e.g. "Security". Omit on the home page. */
  title?: string;
  description: string;
  /** Route path starting with "/", e.g. "/security". */
  path: string;
  /** Social card path. Defaults to the root card. */
  image?: string;
  imageAlt?: string;
}): Metadata {
  const ogTitle = title ? `${title} — ${SITE.name}` : SITE.title;
  const img = { url: image, width: 1200, height: 630, alt: imageAlt, type: "image/png" };
  return {
    ...(title ? { title } : { title: { absolute: SITE.title } }),
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      locale: "en_US",
      url: path,
      title: ogTitle,
      description,
      images: [img],
    },
    twitter: { card: "summary_large_image", title: ogTitle, description, images: [img] },
  };
}
