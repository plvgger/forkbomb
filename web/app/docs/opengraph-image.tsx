import { renderSocialCard } from "../_og/card";

export const alt = "Hydra docs. Install from source, run your first race, and look up every command and flag.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function DocsOpenGraphImage() {
  return renderSocialCard({
    kicker: "Docs",
    title: "Install from source. Run your first race.",
    sub: "Every command, flag and artifact of the Hydra CLI.",
  });
}
