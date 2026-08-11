import { AllocationRings, type RingSlice } from "@/components/viz/AllocationRings.tsx";
import { getPortfolio, resolveCurrentContext, type MandateSummary } from "@/server/portfolio.ts";

// Reads live rows on every request. No model call sits on this path — and none
// ever may; the AI layer is strictly write-behind.
export const dynamic = "force-dynamic";

const MANDATE_COLOR: Record<MandateSummary["kind"], string> = {
  long_term: "var(--accent)",
  catalyst: "var(--positive)",
  active: "var(--text-2)",
};

const MANDATE_LABEL: Record<MandateSummary["kind"], string> = {
  long_term: "Long-Term",
  catalyst: "Catalyst",
  active: "Active",
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const moneyExact = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export default async function TodayPage() {
  const context = await resolveCurrentContext();

  if (!context) {
    return (
      <section className="card empty">
        <EmptyMark />
        <p>
          No account yet.
          <br />
          Run <code>npm run seed -w @vesti/web</code> to create one.
        </p>
      </section>
    );
  }

  const portfolio = await getPortfolio(context.userId, context.accountId);

  if (portfolio.totalEquity === 0) {
    return (
      <section className="card empty">
        <EmptyMark />
        <p>
          Nothing funded yet.
          <br />
          Add a deposit and a position to begin.
        </p>
      </section>
    );
  }

  const slices: RingSlice[] = portfolio.mandates.map((m) => ({
    label: MANDATE_LABEL[m.kind],
    fraction: portfolio.totalEquity === 0 ? 0 : m.marketValue / portfolio.totalEquity,
    color: MANDATE_COLOR[m.kind],
  }));

  const cashFraction = portfolio.totalEquity === 0 ? 0 : portfolio.cash / portfolio.totalEquity;
  const gaining = portfolio.unrealised >= 0;

  return (
    <>
      <section className="card" aria-labelledby="equity-label">
        <div className="hero">
          <div className="heroLeft">
            <div className="label" id="equity-label">
              Total equity
            </div>
            <div className="heroNum">{moneyExact(portfolio.totalEquity)}</div>
            <div className={`delta ${gaining ? "pos" : "neg"}`}>
              <span className="glyph" aria-hidden="true">
                {gaining ? "▲" : "▼"}
              </span>
              <span>
                {moneyExact(Math.abs(portfolio.unrealised))} unrealised
              </span>
            </div>
          </div>
          <AllocationRings slices={slices} size={104} />
        </div>

        <div className="ringLegend">
          {portfolio.mandates.map((mandate) => (
            <div className="legendRow" key={mandate.id}>
              <span className="swatch" style={{ background: MANDATE_COLOR[mandate.kind] }} />
              <span>{MANDATE_LABEL[mandate.kind]}</span>
              <span className="amt">{money(mandate.marketValue)}</span>
              <span className="pct">
                {portfolio.totalEquity === 0
                  ? "0%"
                  : `${Math.round((mandate.marketValue / portfolio.totalEquity) * 100)}%`}
              </span>
            </div>
          ))}
          <div className="legendRow">
            <span className="swatch" style={{ background: "var(--track)" }} />
            <span>Cash</span>
            <span className="amt">{money(portfolio.cash)}</span>
            <span className="pct">{Math.round(cashFraction * 100)}%</span>
          </div>
        </div>
      </section>

      <div className="sectionRule">
        <span className="label">Positions</span>
      </div>

      {portfolio.positions.length === 0 ? (
        <section className="card empty">
          <EmptyMark />
          <p>No open positions.</p>
        </section>
      ) : (
        <section className="card" style={{ paddingTop: 6, paddingBottom: 6 }}>
          <div className="rows">
            {portfolio.positions.map((position) => (
              <div className="row" key={`${position.securityId}-${position.mandateId}`}>
                <span className="rowId">
                  <span className="ticker">{position.symbol}</span>
                  {/* The mandate is part of the position's identity, not a
                      decoration: the same ticker in two mandates is two
                      positions with two theses and two stops. */}
                  <span className="mandateTag">{MANDATE_LABEL[position.mandateKind]}</span>
                </span>
                {/* No price history exists until Phase 2. Drawing a sparkline
                    from cost to cost would render a confident flat line for
                    data we do not have — so show that it is absent instead. */}
                <NoHistory />
                <span className="rowVal">
                  <span className="v">{money(position.marketValue)}</span>
                  <span className="d" style={{ color: "var(--text-3)" }}>
                    {position.quantity.toLocaleString("en-US")} sh
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="footnote">
        Positions are marked at cost until market data lands in Phase 2.
        <br />
        Unrealised P&amp;L will read zero until then.
      </p>
    </>
  );
}

/** Placeholder where a sparkline will go once Phase 2 supplies price history. */
function NoHistory() {
  return (
    <svg width="64" height="26" viewBox="0 0 64 26" role="img" aria-label="No price history yet">
      <line
        x1="8"
        y1="13"
        x2="56"
        y2="13"
        stroke="var(--track)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 5"
      />
    </svg>
  );
}

function EmptyMark() {
  return (
    <svg width="72" height="48" viewBox="0 0 72 48" aria-hidden="true">
      <g fill="none" stroke="var(--accent)" strokeWidth="1.25" strokeLinecap="round" opacity="0.75">
        <path d="M4 32 H26" />
        <path d="M46 32 H68" />
        <circle cx="36" cy="32" r="5.5" />
        <path d="M36 20 V12" opacity="0.45" />
      </g>
    </svg>
  );
}
