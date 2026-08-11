/**
 * Registering strategies and moving them up the promotion ladder.
 *
 * The split here is deliberate: a strategy's RULES are code, reviewed and
 * versioned in the repository, and its STANDING is data. Being able to pause a
 * strategy at 3pm without shipping is worth a great deal; being able to change
 * what it does without review is worth nothing good.
 *
 * `strategy_versions` rejects UPDATE at the table level, so a promotion appends
 * a new row rather than editing one. That is not an obstacle to work around —
 * the ladder a strategy climbed, and who moved it, is exactly the history that
 * matters when a live strategy turns out to be bad. `version` counts revisions
 * of the record; the identity of the rules is `spec.code_version`.
 *
 * ONE STEP AT A TIME, and never past paper by this route. The architecture is
 * explicit that promotion is a deterministic gate evaluation against the
 * validation ladder, and that ladder is Phase 4. Until it exists, the only
 * promotion available is the one a human makes with their eyes open, to paper,
 * where being wrong costs nothing but time.
 */

import type pg from "pg";
import type { Strategy, StrategyStatus } from "@vesti/core/strategy/types.ts";

const LADDER: readonly StrategyStatus[] = [
  "experimental",
  "validating",
  "paper_approved",
  "live_limited",
  "live_scaled",
];

/** Statuses this function will move a strategy to. Live requires the Phase 9 gate. */
const MANUALLY_REACHABLE: ReadonlySet<StrategyStatus> = new Set([
  "validating",
  "paper_approved",
  "paused",
  "retired",
]);

export interface RegisteredStrategy {
  strategyId: string;
  slug: string;
  codeVersion: number;
  version: number;
  status: StrategyStatus;
}

/**
 * Ensures a strategy and its current rule set exist, at `experimental`.
 *
 * Idempotent: re-registering an unchanged strategy returns what is already
 * there rather than appending a revision, so a deploy that runs this on boot
 * does not silently reset a promoted strategy to experimental.
 */
export async function registerStrategy(
  pool: pg.Pool,
  params: { userId: string; strategy: Strategy },
): Promise<RegisteredStrategy> {
  const { strategy } = params;

  const { rows: strategyRows } = await pool.query<{ id: string }>(
    `INSERT INTO strategies (user_id, slug, name, mandate_kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [params.userId, strategy.key, strategy.describe.slice(0, 120), strategy.mandate],
  );
  const strategyId = strategyRows[0]!.id;

  const existing = await currentStanding(pool, strategyId, strategy.version);
  if (existing) return existing;

  const { rows } = await pool.query<{ version: number; status: StrategyStatus }>(
    `INSERT INTO strategy_versions (strategy_id, version, status, spec, authored_by, rationale)
     VALUES (
       $1,
       coalesce((SELECT max(version) FROM strategy_versions WHERE strategy_id = $1), 0) + 1,
       'experimental',
       $2::jsonb,
       'human',
       $3
     )
     RETURNING version, status`,
    [
      strategyId,
      JSON.stringify({ code_version: String(strategy.version), describe: strategy.describe }),
      "registered from the code registry",
    ],
  );

  return {
    strategyId,
    slug: strategy.key,
    codeVersion: strategy.version,
    version: rows[0]!.version,
    status: rows[0]!.status,
  };
}

/**
 * Appends a new standing for a rule set.
 *
 * Refuses to skip rungs, and refuses to reach live at all. A strategy that has
 * never been paper-approved cannot jump to live because somebody was in a
 * hurry, and the one-step rule means every rung leaves a row saying who moved
 * it and why.
 */
export async function promoteStrategy(
  pool: pg.Pool,
  params: {
    userId: string;
    slug: string;
    codeVersion: number;
    to: StrategyStatus;
    rationale: string;
    by?: string;
  },
): Promise<RegisteredStrategy> {
  if (!MANUALLY_REACHABLE.has(params.to)) {
    throw new Error(
      `${params.to} is not reachable by hand. Live promotion is the Phase 9 gate, ` +
        `not a command.`,
    );
  }
  if (!params.rationale.trim()) {
    throw new Error("A promotion needs a rationale. It is the only record of why.");
  }

  const { rows: strategyRows } = await pool.query<{ id: string }>(
    `SELECT id FROM strategies WHERE user_id = $1 AND slug = $2`,
    [params.userId, params.slug],
  );
  const strategyId = strategyRows[0]?.id;
  if (!strategyId) throw new Error(`No strategy "${params.slug}". Register it first.`);

  const standing = await currentStanding(pool, strategyId, params.codeVersion);
  if (!standing) {
    throw new Error(`No registered rule set ${params.slug}@${params.codeVersion}.`);
  }

  // Pausing and retiring are always available — a way to stop must never be
  // gated on being in the right state to stop from.
  if (params.to !== "paused" && params.to !== "retired") {
    const from = LADDER.indexOf(standing.status);
    const to = LADDER.indexOf(params.to);
    if (from === -1) {
      throw new Error(
        `${params.slug} is ${standing.status}; resume it before promoting.`,
      );
    }
    if (to !== from + 1) {
      throw new Error(
        `Refusing to move ${params.slug} from ${standing.status} to ${params.to}. ` +
          `One rung at a time — the next is ${LADDER[from + 1] ?? "nothing"}.`,
      );
    }
  }

  const { rows } = await pool.query<{ version: number; status: StrategyStatus }>(
    `INSERT INTO strategy_versions (strategy_id, version, status, spec, authored_by, rationale)
     VALUES (
       $1,
       coalesce((SELECT max(version) FROM strategy_versions WHERE strategy_id = $1), 0) + 1,
       $2,
       $3::jsonb,
       'human',
       $4
     )
     RETURNING version, status`,
    [
      strategyId,
      params.to,
      JSON.stringify({
        code_version: String(params.codeVersion),
        promoted_from: standing.status,
        by: params.by ?? "operator",
      }),
      params.rationale,
    ],
  );

  return {
    strategyId,
    slug: params.slug,
    codeVersion: params.codeVersion,
    version: rows[0]!.version,
    status: rows[0]!.status,
  };
}

/** The status on the highest revision of one rule set, or null if unregistered. */
export async function currentStanding(
  pool: pg.Pool,
  strategyId: string,
  codeVersion: number,
): Promise<RegisteredStrategy | null> {
  const { rows } = await pool.query<{
    slug: string;
    version: number;
    status: StrategyStatus;
  }>(
    `SELECT st.slug, sv.version, sv.status
       FROM strategy_versions sv
       JOIN strategies st ON st.id = sv.strategy_id
      WHERE sv.strategy_id = $1 AND sv.spec->>'code_version' = $2
      ORDER BY sv.version DESC LIMIT 1`,
    [strategyId, String(codeVersion)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    strategyId,
    slug: row.slug,
    codeVersion,
    version: row.version,
    status: row.status,
  };
}
