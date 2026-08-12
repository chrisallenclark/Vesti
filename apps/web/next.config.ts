import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The repository's `.env` lives at the root; Next only looks in its own
 * directory.
 *
 * Loading it here rather than duplicating the file into `apps/web` matters
 * because the duplicate is the failure: two copies of a connection string drift,
 * and the way you find out is the dashboard quietly reading a database the
 * worker is not writing to. Node 22 can read the file directly, so this costs
 * no dependency.
 *
 * `loadEnvFile` does not overwrite variables that are already set, so a real
 * deployment's environment still wins over a stray local file.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env should not stop the server from starting — the missing
    // variable will say what it is, which is a better error than a parse trace.
  }
}

const config: NextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish driver; keep it out of the bundler so it loads at
  // runtime on the server only. It must never reach the client — the browser
  // has no business holding a database connection string.
  serverExternalPackages: ["pg"],
};

export default config;
