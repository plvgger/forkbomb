import { ImageResponse } from "next/og";
import { MarkSvg } from "./_og/card";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS applies its own rounded mask, so this fills the square edge to edge.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0b",
        }}
      >
        <MarkSvg size={120} />
      </div>
    ),
    size,
  );
}
