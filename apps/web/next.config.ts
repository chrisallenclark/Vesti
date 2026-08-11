import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish driver; keep it out of the bundler so it loads at
  // runtime on the server only. It must never reach the client — the browser
  // has no business holding a database connection string.
  serverExternalPackages: ["pg"],
};

export default config;
