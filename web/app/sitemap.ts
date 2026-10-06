import type { MetadataRoute } from "next";
import { SITE } from "./config";

const ROUTES: { path: string; priority: number; changeFrequency: "weekly" | "monthly" | "yearly" }[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/docs", priority: 0.9, changeFrequency: "weekly" },
  { path: "/security", priority: 0.8, changeFrequency: "monthly" },
  { path: "/token", priority: 0.5, changeFrequency: "monthly" },
  { path: "/burns", priority: 0.5, changeFrequency: "weekly" },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE.url.replace(/\/$/, "");
  const lastModified = new Date("2026-10-05");
  return ROUTES.map((r) => ({
    url: `${base}${r.path === "/" ? "" : r.path}`,
    lastModified,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
