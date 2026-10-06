import { OG_ALT, renderSocialCard } from "./_og/card";

export const alt = OG_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return renderSocialCard();
}
