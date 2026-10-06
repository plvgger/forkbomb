import type { MetadataRoute } from "next";
import { SITE } from "./config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE.name}: fork your coding agent`,
    short_name: SITE.name,
    description: SITE.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#07090b",
    background_color: "#07090b",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
