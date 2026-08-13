import { ImageResponse } from "next/og";

/**
 * The app icon, generated rather than committed as a binary.
 *
 * Two reasons. A checked-in PNG drifts from the palette the moment the theme
 * changes, and nobody notices because nobody opens it. And this repository has
 * no design toolchain, so a generated mark is the only kind that can be edited
 * by whoever is next in this file.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
          fontSize: 300,
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
