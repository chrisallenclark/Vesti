/**
 * The setup script's input handling.
 *
 * Everything here is a paste that actually happened or is one keystroke away
 * from one. The bare password is the real case: a Neon dashboard shows the
 * password in its own copyable field, and copying that instead of the
 * connection string produces `getaddrinfo ENOTFOUND base` several steps later,
 * naming neither the field nor the file. Recognising it early is the whole
 * point, so it is pinned here rather than left to a regex nobody re-reads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseConnectionString,
  roleUrl,
  generatePassword,
  directEndpoint,
} from "./setup.mts";

const NEON =
  "postgresql://neondb_owner:npg_secret@ep-proud-star-aymkjea9.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require";

const errorOf = (input: string): string => {
  const result = parseConnectionString(input);
  assert.ok("error" in result, `expected a rejection for: ${input}`);
  return result.error;
};

const urlOf = (input: string): URL => {
  const result = parseConnectionString(input);
  assert.ok("url" in result, `expected acceptance for: ${input}`);
  return result.url;
};

describe("parseConnectionString", () => {
  it("accepts the string a vendor hands you, preserving sslmode", () => {
    const url = urlOf(NEON);
    assert.equal(url.hostname, "ep-proud-star-aymkjea9.c-5.us-east-2.aws.neon.tech");
    assert.equal(url.username, "neondb_owner");
    assert.equal(url.pathname, "/neondb");
    assert.equal(url.searchParams.get("sslmode"), "require");
  });

  it("names the mistake when given only the password", () => {
    // The exact value that produced ENOTFOUND base.
    assert.match(errorOf("npg_yrIPLu9XCoY7"), /just a password/);
  });

  it("rejects any bare token, not only Neon-shaped ones", () => {
    assert.match(errorOf("hunter2"), /just a password/);
    assert.match(errorOf("some-long-opaque-token"), /just a password/);
  });

  it("strips a psql wrapper and surrounding quotes", () => {
    assert.equal(urlOf(`psql '${NEON}'`).hostname, urlOf(NEON).hostname);
    assert.equal(urlOf(`"${NEON}"`).hostname, urlOf(NEON).hostname);
  });

  it("strips a copied DATABASE_URL= prefix", () => {
    assert.equal(urlOf(`DATABASE_URL=${NEON}`).username, "neondb_owner");
  });

  it("ignores surrounding whitespace from a sloppy paste", () => {
    assert.equal(urlOf(`   ${NEON}  `).pathname, "/neondb");
  });

  it("rejects a URL that is not postgres", () => {
    assert.match(errorOf("https://neon.tech/app/projects"), /postgres/);
  });

  it("rejects a connection string with no database name", () => {
    assert.match(errorOf("postgresql://user:pw@host"), /No database name/);
  });

  it("rejects an empty answer rather than accepting it", () => {
    assert.match(errorOf("   "), /Nothing entered/);
  });

  it("accepts the postgres:// spelling as well as postgresql://", () => {
    assert.equal(urlOf("postgres://u:p@h.example.com/db").protocol, "postgres:");
  });
});

describe("roleUrl", () => {
  const owner = new URL(NEON);

  it("swaps only the credentials, keeping host, database and options", () => {
    const url = new URL(roleUrl(owner, "research", "pw123"));
    assert.equal(url.username, "vesti_research");
    assert.equal(url.hostname, owner.hostname);
    assert.equal(url.pathname, owner.pathname);
    assert.equal(url.searchParams.get("sslmode"), "require");
  });

  it("gives each role its own identity", () => {
    const names = (["app", "research", "execution", "backtest"] as const).map(
      (r) => new URL(roleUrl(owner, r, "pw")).username,
    );
    assert.deepEqual(names, [
      "vesti_app",
      "vesti_research",
      "vesti_execution",
      "vesti_backtest",
    ]);
  });

  it("does not mutate the owner URL it derives from", () => {
    roleUrl(owner, "execution", "pw");
    assert.equal(owner.username, "neondb_owner");
  });

  it("survives a password containing URL-significant characters", () => {
    const url = new URL(roleUrl(owner, "app", "p@ss:w/rd?x=1#y"));
    assert.equal(url.hostname, owner.hostname, "host must not be captured by the password");
    assert.equal(decodeURIComponent(url.password), "p@ss:w/rd?x=1#y");
  });
});

describe("generatePassword", () => {
  it("produces alphanumerics only, so URLs, SQL and shells all survive it", () => {
    for (let i = 0; i < 200; i++) assert.match(generatePassword(), /^[A-Za-z0-9]+$/);
  });

  it("produces something long enough to be worth generating", () => {
    assert.ok(generatePassword().length >= 24);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, generatePassword));
    assert.equal(seen.size, 500);
  });
});

/**
 * Neon hands out a `-pooler` hostname by default, and it is the wrong one for
 * this. That endpoint is PgBouncer in transaction mode, so session-scoped work —
 * creating roles, installing extensions, defining SECURITY DEFINER functions —
 * either fails or lands against an arbitrary backend. Migrations do all three.
 */
describe("directEndpoint", () => {
  const POOLED =
    "postgresql://neondb_owner:pw@ep-proud-star-aymkjea9-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

  it("drops the -pooler suffix so migrations get a real session", () => {
    assert.equal(
      new URL(directEndpoint(POOLED)).hostname,
      "ep-proud-star-aymkjea9.c-5.us-east-2.aws.neon.tech",
    );
  });

  it("keeps every connection option, including channel_binding", () => {
    const url = new URL(directEndpoint(POOLED));
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.equal(url.searchParams.get("channel_binding"), "require");
    assert.equal(url.username, "neondb_owner");
    assert.equal(url.pathname, "/neondb");
  });

  it("leaves a non-pooled host alone", () => {
    const direct = "postgresql://u:pw@ep-plain.c-5.aws.neon.tech/neondb?sslmode=require";
    assert.equal(directEndpoint(direct), direct);
  });

  it("does not fire on a host that merely contains the word pooler", () => {
    const url = "postgresql://u:pw@pooler-db.example.com/db";
    assert.equal(new URL(directEndpoint(url)).hostname, "pooler-db.example.com");
  });
});
