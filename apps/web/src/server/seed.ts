/**
 * Development seed.
 *
 * Creates a user, three mandates, a paper account, and a small set of lots that
 * deliberately includes THE SAME TICKER IN TWO MANDATES — the case the whole
 * lot-level design exists to handle. Run it, open the app, and the two NVDA
 * rows should stay separate with their own stops.
 *
 * Connects as the migration owner because it writes lots and cash, which the
 * app role is not permitted to touch.
 */
import pg from "pg";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is unset. See .env.example.");

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");

    const { rows: userRows } = await client.query<{ id: string }>(
      // users_email_key is a PARTIAL unique index (WHERE email IS NOT NULL), so
      // the predicate has to be restated here for Postgres to infer it.
      `INSERT INTO users (email, display_name) VALUES ('owner@vesti.local', 'Owner')
       ON CONFLICT (email) WHERE email IS NOT NULL
       DO UPDATE SET display_name = excluded.display_name
       RETURNING id`,
    );
    const userId = userRows[0]!.id;

    const mandateIds: Record<string, string> = {};
    for (const [kind, name, weight] of [
      ["long_term", "Long-Term", 0.45],
      ["catalyst", "Catalyst", 0.35],
      ["active", "Active", 0.2],
    ] as const) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO mandates (user_id, kind, name, target_weight) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind) DO UPDATE SET name = excluded.name, target_weight = excluded.target_weight
         RETURNING id`,
        [userId, kind, name, weight],
      );
      mandateIds[kind] = rows[0]!.id;
    }

    let accountId: string;
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM accounts WHERE user_id = $1 AND broker = 'sim' LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (user_id, broker, is_live) VALUES ($1, 'sim', false) RETURNING id`,
        [userId],
      );
      accountId = rows[0]!.id;
    }

    // Each piece is independently idempotent. Tying the deposit to account
    // CREATION was a bug: re-seeding lots against an existing account wrote
    // $87,938 of buys with no funding behind them, leaving negative cash and
    // zero equity. Anything the seed can create twice, it must check twice.
    await client.query(
      `INSERT INTO kill_switch_state (account_id, is_tripped) VALUES ($1, false)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId],
    );
    await client.query(
      `INSERT INTO cash_ledger (account_id, kind, amount, reference)
       SELECT $1, 'deposit', 100000.00, 'initial paper funding'
       WHERE NOT EXISTS (
         SELECT 1 FROM cash_ledger WHERE account_id = $1 AND kind = 'deposit'
       )`,
      [accountId],
    );

    const securities = [
      ["NVDA", "NVIDIA Corporation", "Information Technology", "Semiconductors"],
      ["TSM", "Taiwan Semiconductor", "Information Technology", "Semiconductors"],
      ["LLY", "Eli Lilly and Company", "Health Care", "Pharmaceuticals"],
      ["RKLB", "Rocket Lab USA", "Industrials", "Aerospace & Defense"],
      ["CEG", "Constellation Energy", "Utilities", "Electric Utilities"],
    ] as const;

    const securityIds: Record<string, string> = {};
    for (const [symbol, name, sector, industry] of securities) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO securities (symbol, name, asset_class, exchange, sector, industry, listed_at, source_id)
         SELECT $1, $2, 'equity', 'NASDAQ', $3, $4, DATE '2010-01-01', s.id
         FROM sources s WHERE s.slug = 'manual'
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [symbol, name, sector, industry],
      );
      if (rows[0]) {
        securityIds[symbol] = rows[0].id;
      } else {
        const found = await client.query<{ id: string }>(
          `SELECT id FROM securities WHERE symbol = $1 AND delisted_at IS NULL`,
          [symbol],
        );
        securityIds[symbol] = found.rows[0]!.id;
      }
    }

    const { rows: lotCount } = await client.query<{ count: string }>(
      `SELECT count(*) FROM lots WHERE account_id = $1`,
      [accountId],
    );

    if (Number(lotCount[0]!.count) === 0) {
      // symbol, mandate, qty, cost, stop, target
      //
      // Sized to leave cash POSITIVE. An earlier version of this seed spent
      // $103,010 of a $100,000 deposit, quietly creating a margin balance in an
      // account that is meant to have none. Total below is $87,938, leaving
      // ~$12,062 (12%) in cash.
      const lots = [
        ["TSM", "long_term", 120, 182.5, null, null], //  21,900.00
        ["CEG", "long_term", 80, 237.5, null, null], //   19,000.00
        ["LLY", "catalyst", 24, 863.6, 742.0, 1120.0], // 20,726.40
        ["RKLB", "catalyst", 350, 45.6, 33.5, 88.0], //   15,960.00
        // The same ticker, held twice, for different reasons. The long-term lot
        // has no stop; the tactical lot does. A tactical exit must never be able
        // to reach the long-term shares — the database enforces that.
        ["NVDA", "long_term", 50, 121.4, null, null], //   6,070.00
        ["NVDA", "active", 24, 178.4, 168.9, 202.0], //     4,281.60
      ] as const;

      for (const [symbol, mandate, qty, cost, stop, target] of lots) {
        await client.query(
          `INSERT INTO lots
             (account_id, mandate_id, security_id, opened_at, quantity, remaining, cost_basis, stop_price, target_price)
           VALUES ($1, $2, $3, now() - interval '30 days', $4, $4, $5, $6, $7)`,
          [accountId, mandateIds[mandate], securityIds[symbol], qty, cost, stop, target],
        );
        await client.query(
          `INSERT INTO cash_ledger (account_id, mandate_id, kind, amount, reference)
           VALUES ($1, $2, 'buy', $3, $4)`,
          [accountId, mandateIds[mandate], -(qty * cost), `seed ${symbol}`],
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, payload)
       VALUES ('system:seed', 'seed.applied', 'account', $1, '{"source":"seed.ts"}')`,
      [accountId],
    );

    await client.query("COMMIT");

    const { rows: summary } = await client.query<{ cash: string; invested: string }>(
      `SELECT
         (SELECT coalesce(sum(amount), 0) FROM cash_ledger WHERE account_id = $1) AS cash,
         (SELECT coalesce(sum(remaining * cost_basis), 0) FROM lots WHERE account_id = $1 AND remaining > 0) AS invested`,
      [accountId],
    );

    const cash = Number(summary[0]!.cash);
    const invested = Number(summary[0]!.invested);
    process.stdout.write(
      `seeded account ${accountId}\n` +
        `  cash      $${cash.toFixed(2)}\n` +
        `  invested  $${invested.toFixed(2)}\n` +
        `  equity    $${(cash + invested).toFixed(2)}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
