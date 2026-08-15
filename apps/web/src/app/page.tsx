import { TradingDesk } from "@/components/TradingDesk.tsx";
import { explain, readLiveView, type LiveView } from "@/server/live";

/**
 * The home page is the trading desk.
 *
 * Rendered once on the server so the first paint already carries real state —
 * an autonomous system whose dashboard opens on a spinner is one you cannot
 * check quickly — and then kept current by the client polling `/api/live`.
 *
 * `force-dynamic` because every number here is a claim about right now. No
 * model call sits on this path and none ever may; the AI layer is strictly
 * write-behind.
 */
export const dynamic = "force-dynamic";

export default async function DeskPage() {
  let initial: LiveView | null = null;
  let error: string | null = null;
  try {
    initial = await readLiveView();
  } catch (cause) {
    // The page still renders and the client will retry. A dashboard that throws
    // on a transient database blip is one that cannot tell you the difference
    // between "the database is down" and "the trader is down".
    error = explain(cause);
  }

  return (
    <main className="deskMain">
      {error ? <section className="card empty"><p className="alert">{error}</p></section> : null}
      <TradingDesk initial={initial} />
    </main>
  );
}
