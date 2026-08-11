/**
 * One-command setup.
 *
 * This exists because the manual version kept failing, and it kept failing in
 * ways the person running it could not diagnose. Hand-assembling a `.env` meant
 * writing five connection strings that differ only by role, keeping four
 * passwords in sync with what a migration created, and knowing that a bare
 * `npg_...` string is a password rather than a connection string. Every one of
 * those produced an error message pointing somewhere else: a mistyped URL
 * surfaces as `getaddrinfo ENOTFOUND base`, which names neither the file nor the
 * field at fault.
 *
 * So the only thing asked for here is the one string the database vendor hands
 * you. Everything else is derived, generated, or checked:
 *
 *   - the four role URLs are built from the owner URL, so they cannot drift
 *   - role passwords are generated once and stored, so nothing needs inventing
 *   - role passwords are re-applied on every run, because the migration that
 *     creates them is guarded by IF NOT EXISTS and silently ignores a changed
 *     password — the failure being a `password authentication failed` hours later
 *   - the connection is proven before migrations run, so a bad string fails in
 *     one second with an explanation rather than midway through schema changes
 *
 * Idempotent. Run it again after rotating a credential and it repairs the rest.
 */
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");

const ROLES = ["app", "research", "execution", "backtest"] as const;
type Role = (typeof ROLES)[number];

const say = (s = ""): void => void process.stdout.write(`${s}\n`);

/**
 * Sequential prompting that does not lose input.
 *
 * `readline.question()` alone is wrong here. Readline emits a `line` event for
 * every line already sitting in the buffer, and `question()` only listens for
 * the next one — so anything pasted ahead of the prompt, or piped in, is
 * discarded, and the following `question()` then waits forever on a stream that
 * has already ended. Pasting several answers at once is exactly what someone
 * does when they have been round this loop a few times.
 *
 * Consuming a single async iterator keeps every line and makes the script
 * testable by pipe. EOF is an error rather than a hang, so a non-interactive run
 * that is missing an answer says which one.
 */
function prompter(rl: ReturnType<typeof createInterface>) {
  const lines = rl[Symbol.asyncIterator]();
  return async (question: string): Promise<string> => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    if (done) {
      say();
      throw new Error(`No input available for: ${question.trim()}`);
    }
    say();
    return String(value).trim();
  };
}
const bad = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const good = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

// ── .env as an ordered map ───────────────────────────────────────────────────
// Parsed and rewritten rather than appended to, so re-running cannot leave two
// definitions of the same key with the last one silently winning.

type Env = Map<string, string>;

async function readEnv(): Promise<Env> {
  const env: Env = new Map();
  try {
    const text = await readFile(ENV_PATH, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  } catch {
    /* no .env yet */
  }
  return env;
}

async function writeEnv(env: Env): Promise<void> {
  const lines = [
    "# Written by `npm run setup`. Real credentials — never committed.",
    "# .gitignore already excludes this file. Do not put values in .env.example.",
    "",
  ];
  for (const [k, v] of env) lines.push(`${k}=${v}`);
  await writeFile(ENV_PATH, `${lines.join("\n")}\n`, { mode: 0o600 });
}

// ── The one input ────────────────────────────────────────────────────────────

/**
 * Turns whatever was pasted into a usable URL, or explains precisely why it is
 * not one. The diagnostics are specific because the generic ones cost hours:
 * "invalid connection string" does not tell you that you copied the password
 * field out of a dashboard instead of the string above it.
 */
export function parseConnectionString(raw: string): { url: URL } | { error: string } {
  let s = raw.trim();

  // Dashboards hand out `psql 'postgres://...'`; shells leave the quotes on.
  s = s.replace(/^psql\s+/i, "").replace(/^["']|["']$/g, "").trim();
  if (s.startsWith("DATABASE_URL=")) s = s.slice("DATABASE_URL=".length).trim();

  if (!s) return { error: "Nothing entered." };

  if (/^(npg_|npg-)/i.test(s) || (!s.includes("://") && !s.includes("@"))) {
    return {
      error:
        `That looks like just a password, not a connection string.\n` +
        `  A connection string starts with postgresql:// and contains the host:\n` +
        `  ${dim("postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require")}\n` +
        `  In the Neon dashboard it is the "Connection string" box, not the password field.`,
    };
  }
  if (!s.includes("://")) {
    return { error: `Missing the postgresql:// prefix.\n  Got: ${s.slice(0, 40)}…` };
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { error: `Could not parse that as a URL.\n  Got: ${s.slice(0, 60)}…` };
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { error: `Expected a postgres:// or postgresql:// URL, got ${url.protocol}//` };
  }
  if (!url.hostname) return { error: "No hostname in that connection string." };
  if (!url.username) return { error: "No username in that connection string." };
  if (!url.pathname || url.pathname === "/") {
    return { error: "No database name — the URL should end with /something." };
  }
  return { url };
}

/** A role URL is the owner URL with the credentials swapped. Nothing else moves. */
export function roleUrl(owner: URL, role: Role, password: string): string {
  const u = new URL(owner.toString());
  u.username = `vesti_${role}`;
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** Alphanumeric only: these travel through URLs, SQL literals and shells. */
export const generatePassword = (): string => randomBytes(24).toString("base64url").replace(/[_-]/g, "");

// ── Steps ────────────────────────────────────────────────────────────────────

async function proveConnection(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ version: string; db: string }>(
      "SELECT version() AS version, current_database() AS db",
    );
    say(`  ${good("✓")} connected to ${rows[0]!.db} — ${rows[0]!.version.split(",")[0]}`);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Re-applies role passwords from `.env`.
 *
 * Migration 005 creates each role behind `IF NOT EXISTS`, which means it sets a
 * password exactly once for the lifetime of the cluster. Change the value in
 * `.env` afterwards and nothing complains — the migration is already recorded as
 * applied, so it never runs again, and the mismatch surfaces later as a bare
 * `password authentication failed` from whichever service happened to connect
 * first. Re-asserting here makes `.env` the source of truth it appears to be.
 */
async function syncRolePasswords(ownerUrl: string, passwords: Record<Role, string>): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    for (const role of ROLES) {
      const name = `vesti_${role}`;
      const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
      if (rowCount === 0) continue;
      // Identifier is from a fixed list; the password is a literal, so it is
      // escaped by doubling any quote rather than interpolated blind.
      const escaped = passwords[role].replace(/'/g, "''");
      await client.query(`ALTER ROLE ${name} WITH PASSWORD '${escaped}'`);
    }
    say(`  ${good("✓")} role passwords match .env`);
  } finally {
    await client.end().catch(() => {});
  }
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit", shell: false });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = prompter(rl);
  const env = await readEnv();
  const flags = new Set(process.argv.slice(2));
  const skipIngest = flags.has("--no-ingest");

  say();
  say("Vesti setup");
  say("───────────");

  // 1. The database URL: from .env, an argument, or asked for.
  let ownerUrl = env.get("DATABASE_URL") ?? "";
  const fromArgv = process.argv.slice(2).find((a) => a.includes("://"));
  if (fromArgv) ownerUrl = fromArgv;

  for (;;) {
    const parsed = ownerUrl ? parseConnectionString(ownerUrl) : { error: "" };
    if ("url" in parsed) {
      ownerUrl = parsed.url.toString();
      say(`  ${good("✓")} database ${dim(parsed.url.hostname)}`);
      break;
    }
    if (parsed.error) {
      say();
      say(bad(`  ✗ ${parsed.error}`));
      say();
    }
    ownerUrl = await ask("  Paste your database connection string: ");
  }
  env.set("DATABASE_URL", ownerUrl);

  // 2. Role passwords: generated once, then kept.
  const passwords = {} as Record<Role, string>;
  let generated = 0;
  for (const role of ROLES) {
    const key = `VESTI_${role.toUpperCase()}_PASSWORD`;
    let value = env.get(key) ?? "";
    if (!value || value === "CHANGEME") {
      value = generatePassword();
      generated++;
    }
    passwords[role] = value;
    env.set(key, value);
    env.set(`DATABASE_URL_${role.toUpperCase()}`, roleUrl(new URL(ownerUrl), role, value));
  }
  say(`  ${good("✓")} four role URLs derived${generated ? ` (${generated} password(s) generated)` : ""}`);

  // 3. Credentials that only a human has.
  const alpacaId = env.get("ALPACA_API_KEY_ID") ?? "";
  if (!alpacaId || alpacaId.includes("://")) {
    if (alpacaId.includes("://")) say(bad("  ✗ ALPACA_API_KEY_ID held a URL — that field takes the key ID."));
    say(dim("    Alpaca → API Keys. The ID starts with PK; the secret is the longer value."));
    env.set("ALPACA_API_KEY_ID", await ask("  Alpaca key ID: "));
    env.set("ALPACA_API_SECRET_KEY", await ask("  Alpaca secret: "));
  } else {
    say(`  ${good("✓")} Alpaca keys present`);
  }

  const contact = env.get("SEC_EDGAR_USER_AGENT") ?? "";
  if (!contact.includes("@")) {
    say(dim("    The SEC refuses requests without a real contact address."));
    const email = await ask("  Your email (for the SEC User-Agent): ");
    env.set("SEC_EDGAR_USER_AGENT", `Vesti Research ${email}`);
  } else {
    say(`  ${good("✓")} SEC contact present`);
  }

  env.set("ALPACA_DATA_BASE_URL", env.get("ALPACA_DATA_BASE_URL") ?? "https://data.alpaca.markets");
  env.set(
    "ALPACA_TRADING_BASE_URL",
    env.get("ALPACA_TRADING_BASE_URL") ?? "https://paper-api.alpaca.markets",
  );

  await writeEnv(env);
  say(`  ${good("✓")} .env written`);
  rl.close();

  // 4. Prove the connection before changing anything.
  say();
  say("Checking the database");
  say("─────────────────────");
  try {
    await proveConnection(ownerUrl);
  } catch (error) {
    say();
    say(bad(`  ✗ could not connect: ${(error as Error).message}`));
    say();
    say("  The connection string is saved, so fix the cause and re-run `npm run setup`.");
    say(dim("  Common causes: password reset since the string was copied; the project"));
    say(dim("  is paused in the vendor dashboard; sslmode=require missing from the URL."));
    process.exitCode = 1;
    return;
  }

  // 5. Schema, then make the roles usable.
  say();
  say("Applying migrations");
  say("───────────────────");
  if ((await run("npm", ["run", "migrate", "-w", "@vesti/db"])) !== 0) {
    say(bad("  ✗ migrations failed — nothing after this will work. Output above."));
    process.exitCode = 1;
    return;
  }
  await syncRolePasswords(ownerUrl, passwords);

  if (skipIngest) {
    say();
    say(good("Setup complete."));
    return;
  }

  // 6. Data.
  say();
  say("Ingesting market data (a few minutes)");
  say("─────────────────────────────────────");
  const sync = await run("npm", [
    "run", "ingest", "-w", "@vesti/ingest", "--",
    "sync", "--universe", "starter", "--from", "2016-01-01",
  ]);
  if (sync !== 0) {
    say(bad("  ✗ market data ingestion failed — see above."));
    say(dim("  A 401 means the Alpaca keys are wrong or were rotated after being pasted."));
    process.exitCode = 1;
    return;
  }

  say();
  say("Ingesting EDGAR fundamentals");
  say("────────────────────────────");
  const fundamentals = await run("npm", [
    "run", "ingest", "-w", "@vesti/ingest", "--", "fundamentals", "--universe", "starter",
  ]);
  if (fundamentals !== 0) {
    say(bad("  ✗ fundamentals ingestion failed — see above."));
    process.exitCode = 1;
    return;
  }

  say();
  say(good("Setup complete. The database holds prices, corporate actions and fundamentals."));
  say(dim("Re-run `npm run setup` any time — it repairs config and skips what is done."));
}

// Importable for tests; runs only when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
