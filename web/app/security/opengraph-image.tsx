import { renderSocialCard } from "../_og/card";

export const alt = "Forkbomb security model. Every head is treated as hostile.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function SecurityOpenGraphImage() {
  return renderSocialCard({
    kicker: "Security",
    title: "Every head is treated as hostile.",
    sub: "Threat model, sandbox layers, canary, known limits.",
  });
}
