"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveView, TraderStatus } from "@/server/live";

/**
 * The page you open during market hours to watch the thing work.
 *
 * The editorial rule is one thing, applied everywhere: NEVER SHOW A STATE THE
 * DATA DOES NOT SUPPORT. A worker that died does not write "stopped", it stops
 * writing, so its last row still says `running` — the status shown here is
 * corrected by heartbeat age on the server, and the age is displayed next to it
 * so the correction is checkable rather than trusted. Every panel carries the
 * instant its data was true; a dashboard whose numbers have no timestamps is a
 * dashboard that cannot tell you it has gone stale.
 *
 * Polling rather than a socket. The worker writes every twenty seconds, so a
 * three-second poll is already faster than the data changes, and a socket would
 * add a connection to keep alive, a reconnect path to get wrong and a second
 * way for the page to be silently dead. When the tab is hidden the poll stops:
 * nobody is watching, and a laptop should not spend its battery on it.
 */

const POLL_MS = 3000;

const money = (n: number, digits = 2): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const signedMoney = (n: number): string => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;

const clock = (iso: string | null): string =>
  iso === null
    ? "—"
    : new Date(iso).toLocaleTimeString("en-US", {
        hour12: true,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });

function ago(iso: string | null): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function holding(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Traffic light for one component. `null` means "not applicable right now". */
function Light({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const state = ok === null ? "unknown" : ok ? "ok" : "bad";
  return (
    <div className={`light light-${state}`}>
      <span className="dot" aria-hidden="true" />
      <span className="lightLabel">{label}</span>
      <span className="lightValue">
        {ok === null ? "—" : ok ? "CONNECTED" : "DISCONNECTED"}
        {detail ? <em>{detail}</em> : null}
      </span>
    </div>
  );
}

const STATUS_TONE: Record<TraderStatus, string> = {
  RUNNING: "ok",
  IDLE: "wait",
  STARTING: "wait",
  HALTED: "bad",
  ERROR: "bad",
  STOPPED: "off",
  OFFLINE: "off",
};

export function TradingDesk({ initial }: { initial: LiveView | null }) {
  const [view, setView] = useState<LiveView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [halting, setHalting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/live", { cache: "no-store" });
      const payload = (await response.json()) as LiveView & { error?: string };
      if (!response.ok || payload.error) {
        setError(payload.error ?? `HTTP ${response.status}`);
      } else {
        setView(payload);
        setError(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (document.visibilityState === "visible") await poll();
      if (!cancelled) timer.current = setTimeout(tick, POLL_MS);
    };
    void tick();
    // A hidden tab stops polling; showing it again refreshes immediately rather
    // than leaving up to three seconds of visibly stale numbers.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  const halt = useCallback(async () => {
    const reason = window.prompt(
      "Halt all new orders. Why? (recorded permanently, and you must quote it back to resume)",
      "halted from the dashboard",
    );
    if (reason === null) return;
    setHalting(true);
    try {
      await fetch("/api/killswitch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      await poll();
    } finally {
      setHalting(false);
    }
  }, [poll]);

  if (!view) {
    return (
      <section className="card empty">
        <p>{error ?? "Connecting…"}</p>
      </section>
    );
  }

  if (!view.accountId) {
    return (
      <section className="card empty">
        <p>
          No Alpaca account is bootstrapped yet. Run the paper bootstrap workflow, or{" "}
          <code>npm run paper -w @vesti/execution -- --dry-run</code>.
        </p>
      </section>
    );
  }

  const day = view.workers.find((w) => w.engine === "DAY") ?? null;
  const status: TraderStatus = day?.status ?? "OFFLINE";
  const equity = view.broker?.equity ?? 0;
  const dayPnl = view.broker?.dayPnl ?? null;
  const marketOpen = view.broker?.marketOpen ?? day?.marketOpen ?? false;
  const dayStrategy = view.strategies.find((s) => s.slug.startsWith("day."));
  const strategyActive = dayStrategy?.status === "paper_approved";

  return (
    <div className="desk">
      {/* ── Mode and money ─────────────────────────────────────────────── */}
      <section className="card headline">
        <div className="modeRow">
          <span className={`badge ${view.isLive ? "badge-live" : "badge-paper"}`}>
            {view.isLive ? "LIVE MONEY" : "PAPER MODE"}
          </span>
          <span className="muted">
            Alpaca {view.accountNumber ?? "—"} · market {marketOpen ? "OPEN" : "CLOSED"}
          </span>
          <button className="killBtn" onClick={halt} disabled={halting || view.killSwitch.tripped}>
            {view.killSwitch.tripped ? "HALTED" : halting ? "halting…" : "KILL SWITCH"}
          </button>
        </div>

        <div className="figures">
          <Figure label="Portfolio value" value={money(equity)} />
          <Figure
            label="Today"
            value={dayPnl === null ? "—" : signedMoney(dayPnl)}
            tone={dayPnl === null ? undefined : dayPnl >= 0 ? "pos" : "neg"}
          />
          <Figure label="Cash" value={money(view.broker?.cash ?? 0)} />
          <Figure label="Buying power" value={money(view.broker?.buyingPower ?? 0)} />
          <Figure
            label="Realised today"
            value={signedMoney(view.realizedToday)}
            tone={view.realizedToday >= 0 ? "pos" : "neg"}
          />
        </div>
        <p className="muted stamp">
          Broker figures as of {clock(view.broker?.takenAt ?? null)} ({ago(view.broker?.takenAt ?? null)})
          {view.broker && view.broker.ageSeconds !== null && view.broker.ageSeconds > 120 ? (
            <strong className="warn"> — stale; the worker is not writing.</strong>
          ) : null}
        </p>
      </section>

      {/* ── Is it actually working? ────────────────────────────────────── */}
      <section className="card">
        <h2>
          Autonomous paper trader
          <span className={`status status-${STATUS_TONE[status]}`}>{status}</span>
        </h2>

        {view.killSwitch.tripped ? (
          <p className="alert">
            Kill switch tripped by {view.killSwitch.by ?? "someone"} at{" "}
            {clock(view.killSwitch.at)} — “{view.killSwitch.reason}”.
            <br />
            <span className="muted">
              Resume from the execution CLI, quoting the reason back:{" "}
              <code>npm run session -w @vesti/execution -- --resume &quot;{view.killSwitch.reason}&quot;</code>
            </span>
          </p>
        ) : null}

        {day?.lastError ? (
          <p className="alert">
            Last error ({ago(day.lastErrorAt)}): {day.lastError}
          </p>
        ) : null}

        <div className="lights">
          <Light ok={!view.isLive} label="Mode" detail={day?.tradingMode?.toUpperCase() ?? "PAPER"} />
          <Light ok={marketOpen} label="Market" detail={marketOpen ? "OPEN" : "CLOSED"} />
          <Light ok={day?.alpacaOk ?? null} label="Alpaca" />
          <Light
            ok={day?.marketDataOk ?? null}
            label="Market data"
            detail={day?.lastDataAt ? ago(day.lastDataAt) : undefined}
          />
          <Light ok={day?.databaseOk ?? null} label="Database" />
          <Light
            ok={strategyActive}
            label="Strategy"
            detail={dayStrategy ? `${dayStrategy.slug} · ${dayStrategy.status}` : "not registered"}
          />
          <Light ok={!view.killSwitch.tripped} label="Risk engine" detail="deterministic" />
        </div>

        <dl className="beats">
          <Beat label="Last heartbeat" at={day?.lastBeatAt ?? null} />
          <Beat label="Last market data" at={day?.lastDataAt ?? null} />
          <Beat label="Last evaluation" at={day?.lastEvalAt ?? null} />
          <Beat label="Last order" at={day?.lastOrderAt ?? null} />
        </dl>
        <p className="muted stamp">
          {day
            ? `${day.cycles.toLocaleString()} cycle(s) since ${clock(day.startedAt)} · worker ${day.workerId}`
            : "No DAY worker has ever reported on this account."}
          {error ? <strong className="warn"> — dashboard read failed: {error}</strong> : null}
        </p>
      </section>

      {/* ── Positions ──────────────────────────────────────────────────── */}
      <section className="card">
        <h2>Positions <span className="count">{view.positions.length}</span></h2>
        {view.positions.length === 0 ? (
          <p className="muted">Flat.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="n">Qty</th>
                  <th className="n">Avg cost</th>
                  <th className="n">Price</th>
                  <th className="n">Value</th>
                  <th className="n">Unrealised</th>
                  <th className="n">Stop</th>
                  <th className="n">Target</th>
                  <th>Why it is on</th>
                </tr>
              </thead>
              <tbody>
                {view.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>
                      <strong>{p.symbol}</strong>
                      {p.engine ? <em className="tag">{p.engine}</em> : null}
                    </td>
                    <td className="n">{p.quantity}</td>
                    <td className="n">{money(p.averageCost)}</td>
                    <td className="n">{p.currentPrice === null ? "—" : money(p.currentPrice)}</td>
                    <td className="n">{money(p.marketValue)}</td>
                    <td className={`n ${p.unrealizedPnl >= 0 ? "pos" : "neg"}`}>
                      {signedMoney(p.unrealizedPnl)}
                    </td>
                    <td className="n">{p.stopPrice === null ? "—" : money(p.stopPrice)}</td>
                    <td className="n">{p.targetPrice === null ? "—" : money(p.targetPrice)}</td>
                    <td className="why">
                      {p.entryReasons.length > 0 ? p.entryReasons.join("; ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Open orders ────────────────────────────────────────────────── */}
      <section className="card">
        <h2>Open orders <span className="count">{view.openOrders.length}</span></h2>
        {view.openOrders.length === 0 ? (
          <p className="muted">None working.</p>
        ) : (
          <div className="scroller">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="n">Qty</th>
                  <th className="n">Filled</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Broker id</th>
                </tr>
              </thead>
              <tbody>
                {view.openOrders.map((o) => (
                  <tr key={o.id}>
                    <td><strong>{o.symbol}</strong></td>
                    <td className={o.side === "buy" ? "pos" : "neg"}>{o.side.toUpperCase()}</td>
                    <td className="n">{o.quantity}</td>
                    <td className="n">{o.filledQuantity}</td>
                    <td>{o.status}</td>
                    <td>{clock(o.submittedAt)}</td>
                    <td className="mono">{o.brokerOrderId?.slice(0, 8) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── What it is thinking ────────────────────────────────────────── */}
      <section className="card">
        <h2>Activity</h2>
        {view.activity.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <ol className="feed">
            {view.activity.map((a) => (
              <li key={a.id} className={`feedItem level-${a.level}`}>
                <time>{clock(a.occurredAt)}</time>
                <span className="kind">{a.kind.replace(/_/g, " ")}</span>
                <span className="msg">
                  {a.symbol ? <strong>{a.symbol}</strong> : null} {a.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── The journal ────────────────────────────────────────────────── */}
      <section className="card">
        <h2>Trade journal</h2>
        {view.journal.length === 0 ? (
          <p className="muted">No decisions recorded yet.</p>
        ) : (
          <ul className="journal">
            {view.journal.map((j) => (
              <li key={j.orderId}>
                <div className="jHead">
                  <strong>{j.symbol}</strong>
                  <span className={j.side === "buy" ? "pos" : "neg"}>{j.side.toUpperCase()}</span>
                  <span>{j.filledQuantity || j.quantity} sh</span>
                  {j.fillPrice !== null ? <span>@ {money(j.fillPrice)}</span> : null}
                  <span className="tag">{j.engine ?? "—"}</span>
                  <span className="tag">{j.status}</span>
                  <time>{clock(j.decidedAt)}</time>
                </div>
                <div className="jBody">
                  {j.intent === "exit" ? (
                    <p>
                      Exit ({j.exitReason ?? "—"}) ·{" "}
                      <span className={(j.realizedPnl ?? 0) >= 0 ? "pos" : "neg"}>
                        {j.realizedPnl === null ? "P&L pending" : signedMoney(j.realizedPnl)}
                      </span>{" "}
                      · held {holding(j.holdingSeconds)}
                    </p>
                  ) : (
                    <p>
                      {j.stopPrice !== null ? `stop ${money(j.stopPrice)}` : "no stop"}
                      {j.targetPrice !== null ? ` · target ${money(j.targetPrice)}` : ""}
                      {j.riskAmount !== null ? ` · risking ${money(j.riskAmount)}` : ""}
                    </p>
                  )}
                  {j.reasons.length > 0 ? (
                    <ul className="reasons">
                      {j.reasons.map((reason, index) => (
                        <li key={index}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="figure">
      <span className="figureLabel">{label}</span>
      <span className={`figureValue ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

function Beat({ label, at }: { label: string; at: string | null }) {
  return (
    <div className="beat">
      <dt>{label}</dt>
      <dd>
        {clock(at)} <em>{ago(at)}</em>
      </dd>
    </div>
  );
}
