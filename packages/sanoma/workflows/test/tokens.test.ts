import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { setTimeout as sleep } from "node:timers/promises";
import { testDatabaseUrl } from "sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseOn, prepareDatabase } from "../src/db.ts";
import { HANDOFF_MS, memoryTokens, tokenHash, tokenStore, type Tokens } from "../src/tokens.ts";

// Needs Postgres: `pnpm db:up`. A stored token's one-time handoff (`Tokens.handoff`, `redeem`), on
// the database's store and in memory alike: a code redeemed once, with its PKCE verifier only, a
// wrong verifier leaving it as it was, expiry, two redeems at once, and only the code's hash kept.

const databaseUrl = testDatabaseUrl("tokens");
const pool = new Pool({ connectionString: databaseUrl });
const db = databaseOn(pool);
beforeAll(() => prepareDatabase(databaseUrl));
afterAll(() => pool.end());

/** A PKCE pair, as the machine signing in makes one. */
async function pkce() {
  const verifier = generateRandomCodeVerifier();
  return { verifier, challenge: await calculatePKCECodeChallenge(verifier) };
}

describe.each([
  ["the database's store", () => tokenStore(async () => db)],
  ["memory", () => memoryTokens()],
] as [string, () => Tokens][])("a token's handoff, on %s", (_, make) => {
  const tokens = make();

  it("answers a one-time code, redeemed once with the verifier for the secret's name", async () => {
    const { verifier, challenge } = await pkce();
    const { code } = await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    expect(code).toMatch(/^sch_[\w-]{43}$/);
    expect(await tokens.redeem({ code, verifier })).toEqual({ store: "ACME_TOKEN" });
    expect(await tokens.redeem({ code, verifier })).toBeUndefined();
  });

  it("refuses a wrong verifier, leaving the code to be redeemed with the right one", async () => {
    const { verifier, challenge } = await pkce();
    const other = await pkce();
    const { code } = await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    expect(await tokens.redeem({ code, verifier: other.verifier })).toBeUndefined();
    expect(await tokens.redeem({ code, verifier: challenge })).toBeUndefined();
    expect(await tokens.redeem({ code, verifier })).toEqual({ store: "ACME_TOKEN" });
  });

  it("refuses a code unknown, or another's, alike", async () => {
    const { verifier, challenge } = await pkce();
    await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    expect(await tokens.redeem({ code: `sch_${"a".repeat(43)}`, verifier })).toBeUndefined();
  });

  it("refuses a code once it expired, even with the verifier", async () => {
    const { verifier, challenge } = await pkce();
    const { code } = await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: 50 });
    await sleep(150);
    expect(await tokens.redeem({ code, verifier })).toBeUndefined();
  });

  it("gives the secret to one of several redeems at once", async () => {
    const { verifier, challenge } = await pkce();
    const { code } = await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    const redeemed = await Promise.all(Array.from({ length: 8 }, () => tokens.redeem({ code, verifier })));
    expect(redeemed.filter(Boolean)).toEqual([{ store: "ACME_TOKEN" }]);
  });

  it("lasts five minutes at most", async () => {
    const { challenge } = await pkce();
    for (const ttlMs of [0, -1, 1.5, HANDOFF_MS + 1])
      await expect(tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs })).rejects.toThrow(
        "A handoff lasts 1 to 300000 ms",
      );
  });
});

describe("a token's handoff in the database", () => {
  const tokens = tokenStore(async () => db);

  it("keeps the code's hash alone, never the code or the verifier, and sweeps the expired", async () => {
    const { verifier, challenge } = await pkce();
    const { code } = await tokens.handoff({ store: "SWEPT_TOKEN", challenge, ttlMs: 1 });
    const { rows } = await pool.query("SELECT * FROM sanoma_token_handoffs");
    const text = JSON.stringify(rows);
    expect(text).toContain(tokenHash(code));
    expect(text).not.toContain(code);
    expect(text).not.toContain(verifier);
    await sleep(20);
    // The next handoff sweeps it.
    await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    const left = await pool.query("SELECT 1 FROM sanoma_token_handoffs WHERE code_hash = $1", [tokenHash(code)]);
    expect(left.rowCount).toBe(0);
  });

  it("marks a code redeemed in its row", async () => {
    const { verifier, challenge } = await pkce();
    const { code } = await tokens.handoff({ store: "ACME_TOKEN", challenge, ttlMs: HANDOFF_MS });
    await tokens.redeem({ code, verifier });
    const { rows } = await pool.query("SELECT redeemed_at FROM sanoma_token_handoffs WHERE code_hash = $1", [
      tokenHash(code),
    ]);
    expect(rows[0].redeemed_at).toBeInstanceOf(Date);
  });
});
