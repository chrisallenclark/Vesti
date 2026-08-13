import { NextResponse, type NextRequest } from "next/server";

/**
 * The lock on the front door.
 *
 * This app shows a real portfolio and can HALT a real trading loop. The moment
 * it is deployed somewhere a phone can reach it, so can everybody else, and a
 * URL nobody has guessed yet is not a secret — it is an unlocked door in a
 * quiet street.
 *
 * One shared passphrase, set as `VESTI_PASSCODE`. That is the right size of
 * mechanism for a single-user private tool: accounts, sessions and a password
 * reset flow would all be machinery serving one person who already knows who
 * they are.
 *
 * Two properties it does need, and has:
 *
 *   THE COOKIE IS NOT THE PASSCODE. It is an HMAC of a fixed subject under the
 *   passcode, so what sits in the browser cannot be read back into the secret,
 *   and rotating the passcode invalidates every cookie ever issued.
 *
 *   THE COMPARISON IS CONSTANT-TIME. A byte-by-byte early exit leaks the
 *   passcode's prefix to anybody willing to time a few thousand requests, which
 *   is exactly the kind of thing that is never worth being clever about.
 *
 * If `VESTI_PASSCODE` is unset the gate is OPEN, so `npm run dev` on a laptop
 * needs no ceremony. That is a deliberate default and a dangerous one, which is
 * why the deployment instructions treat setting it as mandatory rather than
 * optional — and why the page says out loud when it is unset.
 */

const COOKIE = "vesti_auth";
const SUBJECT = "vesti-desk-v1";
/** A month. Long enough that a phone is not re-prompted every session. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

async function sign(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(SUBJECT));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compares without leaking where the first difference is. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const passcode = process.env.VESTI_PASSCODE;
  if (!passcode) return NextResponse.next();

  const expected = await sign(passcode);
  const presented = request.cookies.get(COOKIE)?.value;
  if (presented && constantTimeEqual(presented, expected)) return NextResponse.next();

  // A passcode in the query string, which is how the phone gets in the first
  // time: open the link once with `?passcode=…`, and the redirect immediately
  // strips it from the address bar so it does not sit in history.
  const offered = request.nextUrl.searchParams.get("passcode");
  if (offered && constantTimeEqual(offered, passcode)) {
    const clean = request.nextUrl.clone();
    clean.searchParams.delete("passcode");
    const response = NextResponse.redirect(clean);
    response.cookies.set(COOKIE, expected, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: MAX_AGE_SECONDS,
    });
    return response;
  }

  // Deliberately terse, and deliberately the same for a wrong passcode as for
  // none: a locked door should not describe the key.
  return new NextResponse("Not found.", {
    status: 404,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

export const config = {
  // Everything except Next's own static assets and the icons, which carry
  // nothing worth protecting and are fetched by the phone before any cookie
  // exists — gating them makes the home-screen icon a grey square.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest).*)"],
};
