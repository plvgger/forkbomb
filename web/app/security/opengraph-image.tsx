import { renderSocialCard } from "../_og/card";

export const alt = "forkbomb security model. Every fork is treated as hostile.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function SecurityOpenGraphImage() {
  return renderSocialCard({
    kicker: "Security",
    title: "Every fork is treated as hostile.",
    sub: "Threat model, sandbox layers, canary, known limits.",
  });
}
