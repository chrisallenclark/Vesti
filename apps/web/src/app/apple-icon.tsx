import { ImageResponse } from "next/og";

/**
 * The home-screen icon iOS uses.
 *
 * Separate from `icon.tsx` because iOS ignores the manifest icons and wants
 * this one at 180px, and because it does not round the corners itself — a
 * square mark on a dark ground is what actually looks right there.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

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
          background: "#09090b",
          color: "#c8b08a",
          fontSize: 108,
          fontWeight: 600,
          letterSpacing: "-0.05em",
        }}
      >
        V
      </div>
    ),
    size,
  );
}
