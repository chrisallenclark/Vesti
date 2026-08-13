import type { MetadataRoute } from "next";

/**
 * What makes this installable on a phone.
 *
 * `display: standalone` is the part that matters: added to the home screen, it
 * opens without browser chrome, so it reads as an app rather than a bookmark.
 * The theme colour is the page's own background, so the status bar does not
 * sit on a white strip above a dark page.
 *
 * Portrait-primary because the desk is a column of cards and nobody watches a
 * trading session sideways on a phone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vesti — paper trading desk",
    short_name: "Vesti",
    description: "The autonomous paper trader, live.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
