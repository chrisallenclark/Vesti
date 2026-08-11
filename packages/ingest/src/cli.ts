/**
 * Ingestion CLI.
 *
 *   npm run bars -w @vesti/ingest -- --symbols NVDA,TSM --from 2015-01-01
 *
 * Connects as `vesti_research`, which can write market data and evidence but
 * has no write path to orders, fills, or lots. Ingestion runs unattended; it
 * should not hold trading authority.
 */
import pg from "pg";
import { AlpacaProvider } from "./alpaca.ts";
import { ingestDailyBars } from "./bars.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "bars") {
    throw new Error(`Unknown command "${command ?? ""}". Expected: bars`);
  }

  const symbols = (arg("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("Pass --symbols NVDA,TSM");

  const from = arg("from") ?? "2015-01-01";
  const to = arg("to") ?? today();

  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error(
      "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are unset. Free keys: https://alpaca.markets",
    );
  }

  const connectionString = process.env.DATABASE_URL_RESEARCH;
  if (!connectionString) throw new Error("DATABASE_URL_RESEARCH is unset. See .env.example.");

  const provider = new AlpacaProvider({
    keyId,
    secretKey,
    ...(process.env.ALPACA_DATA_BASE_URL ? { baseUrl: process.env.ALPACA_DATA_BASE_URL } : {}),
  });

  const pool = new pg.Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    const report = await ingestDailyBars(client, provider, symbols, from, to);
    process.stdout.write(
      `bars ${from} -> ${to} for ${symbols.join(", ")}\n` +
        `  fetched   ${report.requested}\n` +
        `  inserted  ${report.inserted}\n` +
        `  revised   ${report.revised}\n` +
        `  unchanged ${report.unchanged}\n` +
        `  rejected  ${report.rejected.length}\n`,
    );
    // Bad ticks are surfaced, never swallowed — a silent reject is how a gap in
    // history turns into a strategy that looks better than it is.
    for (const { bar, problems } of report.rejected.slice(0, 20)) {
      process.stdout.write(`    ${bar.symbol} ${bar.sessionDate}: ${problems.join(", ")}\n`);
    }
    if (report.rejected.length > 20) {
      process.stdout.write(`    ... and ${report.rejected.length - 20} more\n`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
