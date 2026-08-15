import { NextResponse } from "next/server";
import { explain, readLiveView } from "@/server/live";

/**
 * The dashboard's only read.
 *
 * `force-dynamic` and `revalidate = 0` because every layer between here and the
 * browser would otherwise be delighted to serve a cached answer, and a cached
 * answer to "is the trader running?" is worse than no answer: it is a stale
 * RUNNING on a process that died, which is the exact failure the heartbeat
 * exists to catch.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  try {
    const view = await readLiveView();
    return NextResponse.json(view, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    // The message, not the stack, and never the connection string. A page that
    // cannot reach the database has to say so — showing an empty dashboard
    // instead would read as "nothing is happening".
    return NextResponse.json(
      { error: explain(error) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
