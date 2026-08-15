import { NextResponse } from "next/server";
import { explain, readLiveView, tripKillSwitchFromApp } from "@/server/live";

/**
 * The kill switch, reachable from the page.
 *
 * POST only, and only in one direction: this halts new orders and cannot
 * resume them. Resuming requires quoting back the reason the switch was tripped
 * — the cheapest possible check that somebody read it — and stays with the
 * execution role's CLI:
 *
 *   npm run session -w @vesti/execution -- --resume "<the reason>"
 *
 * The asymmetry is the design. Stopping must be available from wherever the
 * operator happens to be looking, because a control that is only reachable from
 * a terminal is not reachable at the moment it is needed. Starting again should
 * be deliberate, and deliberate means slightly inconvenient.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const reason = (body.reason ?? "").trim() || "halted from the dashboard";

    const view = await readLiveView();
    if (!view.accountId) {
      return NextResponse.json({ error: "No account to halt." }, { status: 404 });
    }

    await tripKillSwitchFromApp(view.accountId, reason, "dashboard");
    return NextResponse.json({ tripped: true, reason });
  } catch (error) {
    return NextResponse.json(
      { error: explain(error) },
      { status: 500 },
    );
  }
}
