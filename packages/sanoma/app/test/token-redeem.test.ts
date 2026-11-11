import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { useTestApp } from "sanoma/testing/harness";
import { memoryLedger, resolveConfig } from "sanoma/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppHandler, appHandler } from "../src/handler.ts";
import type { AppSnapshot } from "../src/snapshot.ts";
import { freshDatabase } from "../../workflows/test/harness.ts";

// Needs Postgres (`pnpm db:up`); a fresh database each run, since the secrets key is new each run. `POST /api/token/redeem` on the portable handler, as the Worker's
// bundle makes it, behind a login that lets nothing through: a handed-off token for its one-time
// code and PKCE verifier, once, `no-store` and no cookie; one answer, 410, for a code reused,
// expired, unknown or with a wrong verifier, or a token revoked or replaced since.

vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
const testApp = useTestApp(
  { workflows: [], connectors: [], ledger: memoryLedger() },
  { databaseUrl: freshDatabase("token-redeem") },
);
let handler: AppHandler;

beforeAll(() => {
  handler = appHandler(
    {
      resolved: resolveConfig(testApp.config),
      snapshot: () => ({ description: { sites: [] } }) as unknown as AppSnapshot,
      client: testApp.client,
      // A login that answers every request itself: the route is answered before it.
      login: {
        name: "closed",
        check() {},
        handle: async () => new Response("Sign in first", { status: 401 }),
        resolveActor: async () => undefined,
      },
      sites: new Map(),
      entry: { fetch: () => new Response("no pages here", { status: 404 }) },
    },
    { description: { sites: [] } } as unknown as AppSnapshot,
  );
});
afterAll(() => vi.unstubAllEnvs());

/** A token minted and stored under `store`, and a code handing it off to a new verifier. */
async function handedOff(store: string, ttlMs = 300_000) {
  const { id, token } = await testApp.client.tokens.mint({ subject: "visitor:better-auth:owner", groups: [] });
  await testApp.client.setSecret(store, token, { by: "sanoma" });
  const verifier = generateRandomCodeVerifier();
  const challenge = await calculatePKCECodeChallenge(verifier);
  const { code } = await testApp.client.tokens.handoff({ store, tokenId: id, challenge, ttlMs });
  return { id, token, code, verifier };
}

const redeem = (body: unknown, init: RequestInit = {}) =>
  handler.fetch(
    new Request("https://www.sanoma.example/api/token/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
  );

/** A refusal's status and body, which must not tell one refusal from another. */
const refusal = async (res: Response) => ({ status: res.status, body: await res.text() });

describe("POST /api/token/redeem", () => {
  it("answers the token once for the code and its verifier, before the login, no-store and no cookie", async () => {
    const { token, code, verifier } = await handedOff("ONE_TOKEN");
    const res = await redeem({ code, verifier });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const again = await redeem({ code, verifier });
    expect(again.status).toBe(410);
    expect(again.headers.get("cache-control")).toBe("no-store");
  });

  it("answers a wrong verifier as it answers an unknown code, and leaves the code to be redeemed", async () => {
    const { token, code, verifier } = await handedOff("TWO_TOKEN");
    const wrong = await refusal(await redeem({ code, verifier: generateRandomCodeVerifier() }));
    const unknown = await refusal(await redeem({ code: `sch_${"x".repeat(43)}`, verifier }));
    expect(wrong.status).toBe(410);
    expect(wrong).toEqual(unknown);
    expect(await (await redeem({ code, verifier })).json()).toEqual({ token });
  });

  it("refuses an expired code, and a token revoked since the handoff, alike", async () => {
    const expired = await handedOff("THREE_TOKEN", 50);
    await sleep(150);
    const late = await refusal(await redeem({ code: expired.code, verifier: expired.verifier }));
    const revoked = await handedOff("FOUR_TOKEN");
    await testApp.client.tokens.revoke({ id: revoked.id });
    const gone = await refusal(await redeem({ code: revoked.code, verifier: revoked.verifier }));
    expect(late.status).toBe(410);
    expect(gone).toEqual(late);
  });

  it("refuses a code whose secret holds another live token since the handoff", async () => {
    const { code, verifier } = await handedOff("SWAPPED_TOKEN");
    const other = await testApp.client.tokens.mint({ subject: "visitor:better-auth:someone-else", groups: [] });
    await testApp.client.setSecret("SWAPPED_TOKEN", other.token, { by: "sanoma" });
    expect((await redeem({ code, verifier })).status).toBe(410);
  });

  it("gives the token to one of two redeems at once", async () => {
    const { code, verifier } = await handedOff("FIVE_TOKEN");
    const statuses = (await Promise.all([redeem({ code, verifier }), redeem({ code, verifier })])).map((r) => r.status);
    expect(statuses.toSorted()).toEqual([200, 410]);
  });

  it("refuses a body that is not { code, verifier } with 400, one over 1 KiB with 413, and any method but POST with 405", async () => {
    expect((await redeem({ code: "sca_token" })).status).toBe(400);
    expect((await redeem({ code: `sch_${"x".repeat(43)}`, verifier: "short" })).status).toBe(400);
    expect((await redeem(undefined, { body: "not json" })).status).toBe(400);
    const large = await redeem(undefined, { body: JSON.stringify({ code: "x".repeat(2048), verifier: "y" }) });
    expect(large.status).toBe(413);
    expect(large.headers.get("cache-control")).toBe("no-store");
    const get = await handler.fetch(new Request("https://www.sanoma.example/api/token/redeem"));
    expect(get.status).toBe(405);
  });
});
