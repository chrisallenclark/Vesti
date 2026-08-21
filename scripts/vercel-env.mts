/**
 * Hands the deployed dashboard its database URL, without anybody having to see
 * it.
 *
 *   VERCEL_TOKEN=... DATABASE_URL=... npx tsx scripts/vercel-env.mts
 *
 * The problem this solves is small and stubborn. Deploying the desk means
 * setting `DATABASE_URL_APP` on the host, and that value is derived — an HMAC
 * over the owner connection string — so it exists nowhere a person can copy it
 * from. Every way of getting it to a browser goes through a human reading a
 * live credential off a screen, which is the one thing worth avoiding: a
 * credential that has been read is a credential that has been pasted somewhere,
 * and this repository's rule is that no key is ever printed.
 *
 * So it is derived here and posted straight to the host's API. It is never
 * written to a file, never echoed, and never returned in any of the summaries
 * below. The only things printed are the project it went to and the names of
 * the variables that were set.
 *
 * The APP role, deliberately: it reads everything and writes almost nothing —
 * it cannot touch orders, fills or lots. A browser-facing deployment holding
 * the owner or execution URL would quietly undo the boundary that makes the
 * dashboard safe to expose at all.
 */
import { canonicalOwnerUrl, derivePassword, roleUrl } from "./setup.mts";

const API = "https://api.vercel.com";
const TIMEOUT_MS = 20_000;

const say = (s = ""): void => void process.stdout.write(`${s}\n`);
const bad = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const good = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

function die(title: string, ...detail: string[]): never {
  say();
  say(bad(`  ✗ ${title}`));
  for (const line of detail) say(`    ${line}`);
  say();
  process.exit(1);
}

const token = process.env.VERCEL_TOKEN ?? "";
const owner = process.env.DATABASE_URL ?? "";
const wanted = (process.env.VERCEL_PROJECT ?? "").trim();
const teamId = (process.env.VERCEL_TEAM_ID ?? "").trim();
const passcode = process.env.VESTI_PASSCODE ?? "";

if (!token) {
  die(
    "VERCEL_TOKEN is not set.",
    "In Vercel: your avatar (top right) → Account Settings → Tokens → Create.",
    "Then put it in GitHub → Settings → Secrets and variables → Actions.",
  );
}
if (!owner) die("DATABASE_URL is not set.", "This runs from the same secret every other workflow uses.");

/**
 * Every call bounded. `fetch` has no default timeout and a socket that is open
 * but silent never rejects, which in a workflow is a job that hangs until its
 * timeout rather than a failure anybody can read.
 */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, API);
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // Vercel's message is genuinely useful — "not_found", "forbidden", the name
    // of the scope that is wrong — so it is passed through rather than
    // flattened into a status code.
    let message = text;
    let fromVercel = false;
    try {
      const parsed = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
      if (parsed) {
        message = parsed;
        fromVercel = true;
      }
    } catch {
      /* not JSON; the body is the message */
    }
    // The hints only apply to a refusal Vercel itself issued. A 403 from a
    // proxy in between says nothing about the token, and telling somebody their
    // token is fine when the request never arrived sends them the wrong way.
    const hint = !fromVercel
      ? "That did not come from Vercel — something between here and api.vercel.com refused the request."
      : response.status === 403
        ? "The token is valid but not for this project's scope. If the project lives in a Team, set the VERCEL_TEAM_ID secret to that team's ID (Vercel → Team Settings → General)."
        : response.status === 401
          ? "The token was rejected. Create a new one in Vercel → Account Settings → Tokens and update the VERCEL_TOKEN secret."
          : "";
    die(`Vercel said: ${message}`, ...(hint ? [hint] : []));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

type Project = {
  id: string;
  name: string;
  link?: { type?: string; repoId?: number; org?: string; repo?: string };
};

async function findProject(): Promise<Project> {
  const { projects } = await api<{ projects: Project[] }>("/v9/projects?limit=100");

  if (projects.length === 0) {
    die(
      "This Vercel account has no projects yet.",
      "In Vercel: Add New → Project → import chrisallenclark/Vesti,",
      "and set Root Directory to  apps/web  before you deploy.",
    );
  }
  if (wanted) {
    const match = projects.find((p) => p.name === wanted);
    if (!match) {
      die(
        `No Vercel project called "${wanted}".`,
        `The projects on this account are: ${projects.map((p) => p.name).join(", ")}`,
      );
    }
    return match;
  }
  if (projects.length === 1) return projects[0]!;

  // More than one and nothing said which. Guessing would set a credential on
  // somebody else's project, so it stops and lists them.
  die(
    "This Vercel account has more than one project, so it is ambiguous which one is the dashboard.",
    `Projects: ${projects.map((p) => p.name).join(", ")}`,
    "Re-run and put the right name in the `project` box.",
  );
}

async function setEnv(project: Project, key: string, value: string): Promise<void> {
  await api(`/v10/projects/${project.id}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify({
      key,
      value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }),
  });
  say(`  ${good("✓")} ${key} set on ${project.name}`);
}

async function redeploy(project: Project): Promise<void> {
  const link = project.link;
  if (!link?.repoId || link.type !== "github") {
    say(`  ${dim("· no GitHub link on this project, so nothing was redeployed")}`);
    say(`  ${dim("  In Vercel, open the project → Deployments → ··· → Redeploy.")}`);
    return;
  }
  const deployment = await api<{ url?: string }>("/v13/deployments", {
    method: "POST",
    body: JSON.stringify({
      name: project.name,
      project: project.id,
      target: "production",
      gitSource: { type: "github", repoId: link.repoId, ref: "main" },
    }),
  });
  say(`  ${good("✓")} redeploying  ${deployment.url ? `https://${deployment.url}` : "(building)"}`);
}

const canonical = canonicalOwnerUrl(owner);
const explicit = process.env.VESTI_APP_PASSWORD;
const password =
  explicit && explicit !== "CHANGEME" ? explicit : derivePassword(canonical, "app");
const appUrl = roleUrl(new URL(canonical), "app", password);

say();
say("Dashboard configuration");
say("───────────────────────");

const project = await findProject();
say(`  ${good("✓")} project  ${project.name}`);

await setEnv(project, "DATABASE_URL_APP", appUrl);
if (passcode) {
  await setEnv(project, "VESTI_PASSCODE", passcode);
} else {
  say(`  ${dim("· VESTI_PASSCODE not set here, so it was left alone on Vercel")}`);
}

await redeploy(project);

say();
say(good("The dashboard has what it needs."));
say(dim("  Nothing above is a credential: the connection string was posted to"));
say(dim("  Vercel's API and never printed."));
say();
