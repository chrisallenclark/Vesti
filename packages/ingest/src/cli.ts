/**
 * Ingestion CLI.
 *
 *   npm run ingest -w @vesti/ingest -- sync --universe starter --from 2016-01-01
 *   npm run ingest -w @vesti/ingest -- sync --symbols NVDA,TSM --from 2015-01-01
 *
 * Three commands. `sync` is the one to use: bars and corporate actions are only
 * meaningful together. Bars alone give a series with unexplained 75% overnight
 * collapses in it; actions alone have no securities to attach to. `bars` and
 * `actions` exist separately for backfilling one without re-pulling the other.
 *
 * Connects as `vesti_research`, which can write market data and evidence but
 * has no write path to orders, fills, or lots. Ingestion runs unattended; it
 * should not hold trading authority.
 */
import pg from "pg";
import { AlpacaProvider } from "./alpaca.ts";
import { ingestDailyBars } from "./bars.ts";
import { ingestCorporateActions } from "./actions.ts";
import { EdgarClient, INGESTED_CONCEPTS, extractFacts } from "./edgar.ts";
import { ingestFundamentals, knownCiks, recordCik } from "./fundamentals.ts";
import { resolveUniverse } from "./universe.ts";
import type { MarketDataProvider } from "./provider.ts";

type Command = "bars" | "actions" | "sync" | "fundamentals";
const COMMANDS: readonly Command[] = ["bars", "actions", "sync", "fundamentals"];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveSymbols(): string[] {
  const universe = arg("universe");
  if (universe) return [...resolveUniverse(universe).symbols];

  const symbols = (arg("symbols") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    throw new Error("Pass --symbols NVDA,TSM or --universe starter");
  }
  return symbols;
}

async function runBars(
  client: pg.PoolClient,
  provider: MarketDataProvider,
  symbols: readonly string[],
  from: string,
  to: string,
): Promise<void> {
  const report = await ingestDailyBars(client, provider, symbols, from, to);
  process.stdout.write(
    `bars ${from} -> ${to} for ${symbols.length} symbol(s)\n` +
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
}

async function runActions(
  client: pg.PoolClient,
  provider: MarketDataProvider,
  symbols: readonly string[],
  from: string,
  to: string,
): Promise<void> {
  const report = await ingestCorporateActions(client, provider, symbols, from, to);
  process.stdout.write(
    `corporate actions ${from} -> ${to}\n` +
      `  fetched   ${report.requested}\n` +
      `  inserted  ${report.inserted}\n` +
      `  unchanged ${report.unchanged}\n` +
      `  rejected  ${report.rejected.length}\n`,
  );
  // A rejected split is not a cosmetic loss: the price series keeps the
  // discontinuity the split was supposed to explain. Print every one.
  for (const { action, problems } of report.rejected) {
    process.stdout.write(
      `    ${action.symbol} ${action.kind} ex ${action.exDate}: ${problems.join(", ")}\n`,
    );
  }
}

/**
 * XBRL fundamentals for a set of symbols.
 *
 * Resolves each symbol to a CIK once and records it, because EDGAR's ticker
 * file only lists currently-listed companies — a name that delists later can
 * never be resolved from its ticker again, and a survivorship-safe history
 * depends on having written the mapping down while it was still there.
 */
/**
 * Warns when a filer's history is too short to be the company's real history.
 *
 * EDGAR's ticker file points at whichever entity currently files under the
 * ticker, and a reorganization makes that a brand-new CIK with a brand-new
 * filing history. XOM is the live example: the ticker file resolves it to
 * "ExxonMobil Holdings Corp" (CIK 0002115436, a few hundred fact rows), while
 * the decades of Exxon Mobil Corporation financials sit on the predecessor CIK
 * 0000034088 with twenty thousand.
 *
 * Nothing downstream can detect this. The facts that arrive are real, internally
 * consistent, and pass every validator — there are just almost none of them, and
 * a quality screen reading them sees a company with no track record rather than
 * a resolution error. Worse, D-030 records the CIK on first sight and keeps it,
 * so the wrong mapping persists.
 *
 * This does not attempt to resolve the predecessor automatically: successor
 * linkage is not in `companyfacts`, and guessing at it would be a worse failure
 * than reporting it. It says what it saw and leaves the operator to decide.
 */
function warnIfHistoryLooksTruncated(
  symbol: string,
  cik: string,
  facts: readonly { filedAt: string }[],
): void {
  if (facts.length === 0) return;
  let earliest = facts[0]!.filedAt;
  let latest = facts[0]!.filedAt;
  for (const fact of facts) {
    if (fact.filedAt < earliest) earliest = fact.filedAt;
    if (fact.filedAt > latest) latest = fact.filedAt;
  }

  const spanDays = (Date.parse(latest) - Date.parse(earliest)) / 86_400_000;
  if (spanDays >= 730) return;

  process.stdout.write(
    `      ⚠ ${symbol} (CIK ${cik}) has only ${Math.round(spanDays)} days of filing history ` +
      `(${earliest} → ${latest}).\n` +
      `        A ticker that reorganized resolves to the successor entity, whose history starts\n` +
      `        at the reorganization; the predecessor CIK holds the rest. Verify at\n` +
      `        https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(symbol)}\n`,
  );
}

async function runFundamentals(
  client: pg.PoolClient,
  symbols: readonly string[],
  since: string,
): Promise<void> {
  const userAgent = process.env.SEC_EDGAR_USER_AGENT;
  if (!userAgent) {
    throw new Error(
      'SEC_EDGAR_USER_AGENT is unset. The SEC requires a real contact address, e.g. ' +
        '"Vesti Research you@example.com". See .env.example.',
    );
  }

  const edgar = new EdgarClient({ userAgent });
  const alreadyKnown = await knownCiks(client, symbols);
  const missing = symbols.filter((s) => !alreadyKnown.has(s));

  // The ticker file is ~1MB and covers every listed company, so it is fetched
  // once and only when something still needs resolving.
  let tickerMap: Map<string, string> | null = null;
  if (missing.length > 0) tickerMap = await edgar.fetchTickerMap();

  const totals = {
    requested: 0,
    inserted: 0,
    unchanged: 0,
    restatements: 0,
    rejected: 0,
    withoutFacts: 0,
  };

  for (const symbol of symbols) {
    const known = alreadyKnown.get(symbol);
    let cik = known?.cik;

    if (!cik) {
      cik = tickerMap?.get(symbol);
      if (!cik) {
        process.stdout.write(`  ${symbol}: no CIK in EDGAR's ticker file — skipped\n`);
        continue;
      }
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM securities WHERE symbol = $1 AND delisted_at IS NULL`,
        [symbol],
      );
      const securityId = rows[0]?.id;
      if (!securityId) {
        process.stdout.write(`  ${symbol}: not in securities — ingest bars first\n`);
        continue;
      }
      await recordCik(client, { securityId, cik });
    }

    const document = await edgar.fetchCompanyFacts(cik);
    if (document === null) {
      // An ETF or trust: a real filer with a real CIK and no XBRL facts. Not a
      // failure, and not something to retry.
      process.stdout.write(`  ${symbol} (CIK ${cik}): no XBRL facts at EDGAR — skipped\n`);
      totals.withoutFacts += 1;
      continue;
    }
    const facts = extractFacts(document, symbol, { concepts: INGESTED_CONCEPTS, since });
    const report = await ingestFundamentals(client, "sec_edgar", facts);

    totals.requested += report.requested;
    totals.inserted += report.inserted;
    totals.unchanged += report.unchanged;
    totals.restatements += report.restatements;
    totals.rejected += report.rejected.length;

    process.stdout.write(
      `  ${symbol} (CIK ${cik}): ${report.inserted} new, ${report.restatements} restated, ` +
        `${report.unchanged} unchanged, ${report.rejected.length} rejected\n`,
    );
    warnIfHistoryLooksTruncated(symbol, cik, facts);
    // A rejected fact is not cosmetic: 'filed before the period it reports had
    // ended' is look-ahead with a timestamp on it, and it must be visible.
    for (const { fact, problems } of report.rejected.slice(0, 5)) {
      process.stdout.write(
        `      ${fact.concept} ${fact.periodEnd}: ${problems.join(", ")}\n`,
      );
    }
  }

  process.stdout.write(
    `fundamentals since ${since}\n` +
      `  fetched      ${totals.requested}\n` +
      `  inserted     ${totals.inserted}\n` +
      `  restatements ${totals.restatements}\n` +
      `  unchanged    ${totals.unchanged}\n` +
      `  rejected     ${totals.rejected}\n` +
      `  no facts     ${totals.withoutFacts} (ETFs and trusts file none)\n`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(
      `Unknown command "${command ?? ""}". Expected one of: ${COMMANDS.join(", ")}`,
    );
  }

  const symbols = resolveSymbols();
  const from = arg("from") ?? "2015-01-01";
  const to = arg("to") ?? today();

  // EDGAR needs no Alpaca key, so the check is scoped to the commands that do.
  const needsAlpaca = command !== "fundamentals";
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (needsAlpaca && (!keyId || !secretKey)) {
    throw new Error(
      "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are unset. Free keys: https://alpaca.markets",
    );
  }

  const connectionString = process.env.DATABASE_URL_RESEARCH;
  if (!connectionString) throw new Error("DATABASE_URL_RESEARCH is unset. See .env.example.");

  const provider = new AlpacaProvider({
    keyId: keyId ?? "",
    secretKey: secretKey ?? "",
    ...(process.env.ALPACA_DATA_BASE_URL ? { baseUrl: process.env.ALPACA_DATA_BASE_URL } : {}),
    // Only "iex" is worth naming now that SIP is the default; anything else,
    // including unset, takes the full tape.
    ...(process.env.ALPACA_FEED === "iex" ? { feed: "iex" as const } : {}),
  });

  const pool = new pg.Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    // Bars before actions, always: `ingestCorporateActions` attaches to
    // securities that already exist and rejects symbols it has never seen, so
    // the reverse order silently drops every action on a first run.
    if (command === "bars" || command === "sync") {
      await runBars(client, provider, symbols, from, to);
    }
    if (command === "actions" || command === "sync") {
      await runActions(client, provider, symbols, from, to);
    }
    if (command === "fundamentals") {
      await runFundamentals(client, symbols, from);
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
