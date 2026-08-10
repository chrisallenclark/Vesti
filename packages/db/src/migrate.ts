/**
 * Migration runner.
 *
 * Deliberately boring: numbered SQL files applied in lexical order, each in its
 * own transaction, recorded in schema_migrations with a checksum. If a file
 * changes after being applied, the runner refuses to proceed rather than
 * silently diverging — schema drift between environments is how look-ahead bugs
 * and permission holes get shipped.
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

type Migration = { name: string; sql: string; checksum: string };

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Role passwords are injected at apply time rather than written into the SQL,
 * so migrations stay committable and secrets stay in the environment.
 */
function substituteEnv(sql: string): string {
  return sql.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = process.env[key];
    if (value === undefined || value === "") {
      throw new Error(
        `Migration references \${${key}} but it is unset. Set it in .env (see .env.example).`,
      );
    }
    // Single quotes would break out of the SQL literal these are used in.
    if (value.includes("'")) throw new Error(`${key} must not contain a single quote.`);
    return value;
  });
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is unset. See .env.example.");
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function up(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations();
  const { rows } = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new Error(
          `${migration.name} was modified after being applied. ` +
            `Migrations are immutable — add a new migration instead.`,
        );
      }
      continue;
    }

    process.stdout.write(`  applying ${migration.name} ... `);
    try {
      await client.query("BEGIN");
      await client.query(substituteEnv(migration.sql));
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      await client.query("COMMIT");
      process.stdout.write("ok\n");
    } catch (error) {
      await client.query("ROLLBACK");
      process.stdout.write("FAILED\n");
      throw error;
    }
  }
  process.stdout.write("migrations up to date\n");
}

async function status(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations();
  const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  for (const m of migrations) {
    process.stdout.write(`  ${applied.has(m.name) ? "applied" : "pending"}  ${m.name}\n`);
  }
}

/**
 * Drops and recreates the public schema. Refuses to run against anything that
 * does not look like a local or explicitly-marked development database.
 */
async function reset(client: pg.Client): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
  if (!isLocal && process.env.VESTI_ALLOW_DESTRUCTIVE_RESET !== "yes") {
    throw new Error(
      "Refusing to reset a non-local database. Set VESTI_ALLOW_DESTRUCTIVE_RESET=yes to override.",
    );
  }
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  process.stdout.write("schema reset\n");
  await up(client);
}

const command = process.argv[2] ?? "up";
const client = await connect();
try {
  if (command === "up") await up(client);
  else if (command === "status") await status(client);
  else if (command === "reset") await reset(client);
  else throw new Error(`Unknown command: ${command}. Expected up | status | reset.`);
} finally {
  await client.end();
}
