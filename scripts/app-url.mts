/**
 * Prints the one connection string the dashboard needs, and nothing else.
 *
 *   npm run app-url
 *
 * Exists because deploying the desk means pasting `DATABASE_URL_APP` into a
 * hosting provider, and the alternatives for getting it are all bad: reading it
 * out of `.env` means knowing which of nine similar-looking lines is the right
 * one, and printing it from a workflow would put a live credential in a public
 * repository's build log.
 *
 * It prints the APP role deliberately. That role can read everything and write
 * almost nothing — it cannot touch orders, fills or lots. Handing a browser-
 * facing deployment the owner or execution URL instead would quietly undo the
 * only boundary that makes the dashboard safe to expose at all.
 */

import { canonicalOwnerUrl, derivePassword, roleUrl } from "./setup.mts";

const owner = process.env.DATABASE_URL;
if (!owner) {
  process.stderr.write(
    "DATABASE_URL is unset.\n\n" +
      "Run this with your database connection string, the same one in your\n" +
      "GitHub secret:\n\n" +
      "  DATABASE_URL='postgres://...' npm run app-url\n",
  );
  process.exit(1);
}

// Normalised exactly as setup normalises it. The password is an HMAC over this
// string, so hashing the URL as typed — with Neon's `-pooler` suffix still on
// it — produces a password the database has never been given.
const canonical = canonicalOwnerUrl(owner);

const explicit = process.env.VESTI_APP_PASSWORD;
const password =
  explicit && explicit !== "CHANGEME" ? explicit : derivePassword(canonical, "app");

process.stdout.write(`${roleUrl(new URL(canonical), "app", password)}\n`);
