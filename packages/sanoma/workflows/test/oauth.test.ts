import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findSentinels, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { connectionAttempts, connectionHealth, connections, connectionSetups, ledger } from "../src/db/company.ts";
import { workflowStatus } from "../src/db/dbos.ts";
import {
  AuthenticationError,
  authenticationCredentials,
  defineAuthentication,
  defineConnection,
  defineConnector,
  defineDriver,
  memorySecretStore,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type SecretStore,
  startWorker,
  withSetup,
} from "../src/index.ts";
import { lazyDb } from "../src/db.ts";
import { secret } from "../src/secret.ts";

// OAuth consent end to end over a controllable provider (msw): its authorization endpoint is the
// test's own "consent", which mints a code for the challenge the consent URL carries; its token
// endpoint checks the client, the redirect URI and the PKCE verifier, and takes each code once.
// Every code, verifier, state and token is a sentinel the last test looks for in workflow history.

const PROVIDER = "https://oauth.acme.test";
const API = "https://api.acme.test";
const CLIENT = { clientId: "acme-client", clientSecret: "SENTINEL-client-secret" };
const REDIRECT = "https://app.example.test/connect/acme/callback";

/** Each code the provider issued: the challenge and redirect it was issued for, and the account. */
const issued = new Map<string, { challenge: string; redirectUri: string; account: string; used: boolean }>();
/** Each access token the provider issued, by token: the account it reaches. */
const tokens = new Map<string, string>();
const tokenRequests = vi.fn<() => void>();
/** The secrets each test saw, to look for in workflow history. */
const sentinels = new Set<string>([CLIENT.clientSecret]);

const provider = setupServer(
  http.post(`${PROVIDER}/token`, async ({ request }) => {
    tokenRequests();
    const form = new URLSearchParams(await request.text());
    // RFC 6749 2.3.1: each half form-encoded, then joined and base64'd.
    const basic = atob(request.headers.get("authorization")?.replace(/^Basic /, "") ?? "")
      .split(":")
      .map(decodeURIComponent);
    if (basic[0] !== CLIENT.clientId || basic[1] !== CLIENT.clientSecret)
      return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
    const code = issued.get(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      form.get("grant_type") !== "authorization_code" ||
      !code ||
      code.used ||
      code.redirectUri !== form.get("redirect_uri") ||
      code.challenge !== challenge
    )
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    code.used = true;
    const access = `SENTINEL-access-${randomUUID()}`;
    const refresh = `SENTINEL-refresh-${randomUUID()}`;
    sentinels.add(access).add(refresh);
    tokens.set(access, code.account);
    return HttpResponse.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    });
  }),
  http.get(`${API}/me`, ({ request }) => {
    const account = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return account ? HttpResponse.json({ account }) : HttpResponse.json({}, { status: 401 });
  }),
  http.get(`${API}/thing`, ({ request }) => {
    const account = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return account ? HttpResponse.json({ thing: `of ${account}` }) : HttpResponse.json({}, { status: 401 });
  }),
);

const oauth = defineAuthentication({
  kind: "oauth2",
  version: 1,
  storage: { writable: true, conditionalWrites: true, maxBytes: 4096 },
  oauth: {
    authorizeUrl: `${PROVIDER}/authorize`,
    tokenUrl: `${PROVIDER}/token`,
    scopes: ["read"],
    pkce: true,
    clientAuthentication: "client_secret_basic",
    refresh: "refresh_token",
  },
  async verify(grant) {
    const res = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${grant.accessToken}` } });
    if (!res.ok) throw new AuthenticationError("rejected");
    const { account } = (await res.json()) as { account: string };
    return { account, scopes: grant.scopes ?? [], ...(grant.expiresAt && { expiresAt: grant.expiresAt }) };
  },
});
const ops = defineConnector("acme", {
  thing: { read: { effect: "read", input: z.object({}), output: z.object({ thing: z.string() }) } },
});
const acme = withSetup(ops, {
  authentication: { oauth },
  driver: () =>
    defineDriver(
      ops,
      {
        thing: {
          read: async (_input, call) => {
            const { accessToken } = authenticationCredentials("oauth", oauth, call);
            const res = await fetch(`${API}/thing`, { headers: { authorization: `Bearer ${accessToken}` } });
            return (await res.json()) as { thing: string };
          },
        },
      },
      { authentication: ["oauth"] },
    ),
});
const main = defineConnection(acme, {
  name: "main",
  method: "oauth",
  credentials: secret("ACME_MAIN"),
  client: secret("ACME_APP"),
  scopes: ["read"],
  account: "org-1",
});
const target = { connection: { vendor: "acme", $connection: main.$connection } };

const databaseUrl = testDatabaseUrl("oauth");
const pool = lazyDb(databaseUrl, "oauth-tests");
const config = (store: SecretStore = memorySecretStore()): SanomaConfig => ({
  databaseUrl,
  workflows: [],
  connectors: [acme],
  connections: [main],
  secrets: { store },
});

/** The provider's consent page: a code for the consent URL's challenge and redirect, sent back with its state. */
function consent(url: string, account = "org-1", tamper?: "challenge") {
  const consented = new URL(url);
  const challenge = consented.searchParams.get("code_challenge")!;
  const code = `SENTINEL-code-${randomUUID()}`;
  const state = consented.searchParams.get("state")!;
  sentinels.add(code).add(state);
  issued.set(code, {
    challenge: tamper === "challenge" ? `${challenge}x` : challenge,
    redirectUri: consented.searchParams.get("redirect_uri")!,
    account,
    used: false,
  });
  return new URLSearchParams({ code, state });
}

beforeAll(async () => {
  provider.listen({ onUnhandledFrame: "bypass" });
  // Prepares the database: the client's first connection makes the tables.
  await (await SanomaClient.connect(config())).close();
});
afterAll(async () => {
  provider.close();
  await pool.close();
});
beforeEach(async () => {
  const db = await pool.db();
  await db.execute(
    sql`TRUNCATE ${connections}, ${connectionSetups}, ${connectionHealth}, ${connectionAttempts}, ${ledger}`,
  );
  await db.execute(sql`TRUNCATE ${workflowStatus} CASCADE`);
  tokenRequests.mockClear();
});
// Every test's history, before the next one truncates it: no code, verifier, state, token or
// client secret in any column of the database (the attempts' rows hold them sealed).
afterEach(async (test) => {
  vi.restoreAllMocks();
  test.expect(await findSentinels(databaseUrl, sentinels)).toEqual([]);
});

/** Runs `body` with a client and a worker over `store`. */
async function withRuntime(
  body: (client: SanomaClient) => Promise<void>,
  store: SecretStore = memorySecretStore(),
): Promise<void> {
  const cfg = config(store);
  const worker = await startWorker(cfg);
  const client = await SanomaClient.connect(cfg);
  try {
    await body(client);
  } finally {
    await client.close();
    await worker.stop();
  }
}

/** Starts an attempt as alice with the application's credentials. */
const authorize = (client: SanomaClient, actor = "alice") =>
  client.authorizeConnection(target, { actor, id: randomUUID(), redirectUri: REDIRECT, client: CLIENT });

/** The `connect` run's end, as its summary says it. */
const settled = (client: SanomaClient, runId: string) =>
  waitFor(
    () => client.run(runId),
    (run) => run?.status === "finished" || run?.status === "failed",
    20_000,
  );

describe("OAuth consent", () => {
  it("adds the built-in connect workflow only to a config with a connection that consents by OAuth", () => {
    expect(resolveConfig(config()).workflows.has("connect")).toBe(true);
    expect(resolveConfig({ ...config(), connections: [] }).workflows.has("connect")).toBe(false);
  });

  it("connects through consent, a callback and the worker's exchange, and calls with the stored grant", async () => {
    const store = memorySecretStore();
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const url = new URL(started.url);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        response_type: "code",
        scope: "read",
        code_challenge_method: "S256",
      });
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toEqual({
        state: "waiting",
        connection: "acme/main",
      });
      const { runId } = await client.receiveConnection("acme", started.attempt, consent(started.url), {
        actor: "alice",
      });
      expect((await settled(client, runId))?.status).toBe("finished");
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toEqual({
        state: "connected",
        connection: "acme/main",
        runId,
      });
      const [card] = await client.connections({ actor: "alice" });
      expect(card).toMatchObject({ id: "acme/main", status: "connected", account: "org-1", scopes: ["read"] });
      expect(Date.parse(card!.health!.expiresAt!)).toBeGreaterThan(Date.now() + 3_000_000);
      expect(await client.call("acme.thing.read", {}, { actor: "alice", connection: main })).toEqual({
        thing: "of org-1",
      });
      // The application and the grant are two bundles: the grant never holds the client secret.
      const grant = await store.read({ namespace: "default", path: "ACME_MAIN" });
      expect(grant?.value).toContain("SENTINEL-access-");
      expect(grant?.value).not.toContain(CLIENT.clientSecret);
      expect((await store.read({ namespace: "default", path: "ACME_APP" }))?.value).toContain(CLIENT.clientSecret);
      // Replacing the shared OAuth application is in the authorize decision, for policy and the ledger.
      const records = await (await pool.db()).select({ record: ledger.record }).from(ledger);
      expect(JSON.stringify(records)).toContain('"replacesApplication":true');
    }, store);
  }, 60_000);

  it("refuses a callback whose state another attempt or browser holds, and one for another person (CSRF)", async () => {
    await withRuntime(async (client) => {
      const mine = await authorize(client);
      const theirs = await authorize(client);
      // The attacker's code and state, delivered to the person's browser holding their own attempt.
      await expect(
        client.receiveConnection("acme", mine.attempt, consent(theirs.url), { actor: "alice" }),
      ).rejects.toMatchObject({ name: "CallbackError", reason: "mismatch" });
      await expect(
        client.receiveConnection("acme", mine.attempt, consent(mine.url), { actor: "mallory" }),
      ).rejects.toMatchObject({ reason: "mismatch" });
      await expect(
        client.receiveConnection("other", mine.attempt, consent(mine.url), { actor: "alice" }),
      ).rejects.toMatchObject({ reason: "mismatch" });
      expect(tokenRequests).not.toHaveBeenCalled();
    });
  });

  it("takes a callback once: a replayed one is refused and the code is never sent twice", async () => {
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const callback = consent(started.url);
      const { runId } = await client.receiveConnection("acme", started.attempt, callback, { actor: "alice" });
      await expect(
        client.receiveConnection("acme", started.attempt, callback, { actor: "alice" }),
      ).rejects.toMatchObject({ reason: "replayed" });
      expect((await settled(client, runId))?.status).toBe("finished");
      // The exchange's own replay (a retried step, a second run) finds the attempt consumed.
      const registry = (client as unknown as { config: { connections: { attempts: any } } }).config.connections;
      await expect(registry.attempts.take(started.attempt, "alice", "acme/main")).rejects.toMatchObject({
        problem: "uncertain",
      });
      expect(tokenRequests).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it("fails the exchange when the verifier is not the one the code was issued for (PKCE)", async () => {
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const { runId } = await client.receiveConnection(
        "acme",
        started.attempt,
        consent(started.url, "org-1", "challenge"),
        {
          actor: "alice",
        },
      );
      expect((await settled(client, runId))?.status).toBe("failed");
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "rejected",
      });
      expect((await client.connections({ actor: "alice" }))[0]?.status).toBe("missing");
    });
  }, 60_000);

  it("expires an abandoned attempt, at the callback and at the exchange, and sweeps it", async () => {
    await withRuntime(async (client) => {
      const db = await pool.db();
      const abandoned = await authorize(client);
      await db.execute(sql`UPDATE ${connectionAttempts} SET expires_at = now() - interval '1 second'`);
      await expect(
        client.receiveConnection("acme", abandoned.attempt, consent(abandoned.url), { actor: "alice" }),
      ).rejects.toMatchObject({ reason: "expired" });
      expect(await client.connectionAttempt(abandoned.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "expired",
      });
      // An attempt whose code waited too long for the exchange.
      const late = await authorize(client);
      const registry = (client as unknown as { config: { connections: { attempts: any } } }).config.connections;
      await registry.attempts.receive(late.attempt, "alice", consent(late.url), async () => oauth.oauth);
      await db.execute(sql`UPDATE ${connectionAttempts} SET expires_at = now() - interval '1 second'`);
      await expect(registry.attempts.take(late.attempt, "alice", "acme/main")).rejects.toMatchObject({
        problem: "expired",
      });
      // The exchange's run (held for an approval, say) finds it so, and the attempt says why.
      const [held] = await db
        .select()
        .from(connectionAttempts)
        .where(sql`${connectionAttempts.id} = ${late.attempt}`);
      const runId = `connect:${late.attempt}`;
      await client.start(
        "connect",
        { target: held!.target, requestId: held!.requestId, attempt: late.attempt },
        { startedBy: "alice", runId },
      );
      expect((await settled(client, runId))?.status).toBe("failed");
      expect(await client.connectionAttempt(late.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "expired",
      });
      // Long expired: the next attempt sweeps both, their sealed verifiers with them.
      await db.execute(sql`UPDATE ${connectionAttempts} SET expires_at = now() - interval '2 hours'`);
      await authorize(client);
      expect((await db.select().from(connectionAttempts)).map((row) => row.id)).not.toContain(abandoned.attempt);
      expect(tokenRequests).not.toHaveBeenCalled();
    });
  }, 60_000);

  it("ends an attempt whose connect run could not start, its code dropped", async () => {
    await withRuntime(async (client) => {
      const started = await authorize(client);
      vi.spyOn(client, "start").mockRejectedValueOnce(new Error("queue down"));
      await expect(
        client.receiveConnection("acme", started.attempt, consent(started.url), { actor: "alice" }),
      ).rejects.toThrow("queue down");
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "unavailable",
      });
      const [row] = await (
        await pool.db()
      )
        .select()
        .from(connectionAttempts)
        .where(sql`${connectionAttempts.id} = ${started.attempt}`);
      expect(row?.code).toBeNull();
      expect(tokenRequests).not.toHaveBeenCalled();
    });
  });

  it("refuses an exchange for a connection that changed since consent, sending no code", async () => {
    await withRuntime(async (client) => {
      const first = await authorize(client);
      const { runId } = await client.receiveConnection("acme", first.attempt, consent(first.url), { actor: "alice" });
      expect((await settled(client, runId))?.status).toBe("finished");
      // Reconnect consents to this revision; someone else changes the connection before the callback.
      const again = await authorize(client);
      await (await pool.db()).update(connections).set({ revision: randomUUID() });
      const late = await client.receiveConnection("acme", again.attempt, consent(again.url), { actor: "alice" });
      expect((await settled(client, late.runId))?.status).toBe("failed");
      expect(await client.connectionAttempt(again.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "unavailable",
      });
      expect(tokenRequests).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it("ends an attempt the person declined at the provider", async () => {
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const state = new URL(started.url).searchParams.get("state")!;
      await expect(
        client.receiveConnection("acme", started.attempt, new URLSearchParams({ error: "access_denied", state }), {
          actor: "alice",
        }),
      ).rejects.toMatchObject({ reason: "declined" });
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "declined",
      });
    });
  });

  it("ends an attempt on another error the provider sends, keeping and repeating nothing it said", async () => {
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const state = new URL(started.url).searchParams.get("state")!;
      const said = `SENTINEL-description-${randomUUID()}`;
      sentinels.add(state).add(said);
      const callback = new URLSearchParams({
        error: "server_error",
        error_description: said,
        error_uri: `https://oauth.test/errors/${said}`,
        state,
      });
      const error = (await client
        .receiveConnection("acme", started.attempt, callback, { actor: "alice" })
        .catch((e: unknown) => e)) as Error;
      expect(error).toMatchObject({ reason: "rejected" });
      expect(JSON.stringify({ error, message: error.message, stack: error.stack })).not.toContain(said);
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "rejected",
      });
    });
  });

  it("refuses a grant for another account than the declaration's, storing nothing", async () => {
    const store = memorySecretStore();
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const { runId } = await client.receiveConnection("acme", started.attempt, consent(started.url, "org-2"), {
        actor: "alice",
      });
      expect((await settled(client, runId))?.status).toBe("failed");
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        problem: "wrong_account",
      });
      expect(await store.read({ namespace: "default", path: "ACME_MAIN" })).toBeUndefined();
    }, store);
  }, 60_000);

  it("marks a grant the provider issued but the store did not keep as uncertain, and never replays the code", async () => {
    const store = memorySecretStore();
    const write = store.write.bind(store);
    vi.spyOn(store, "write").mockImplementation(async (address, value, options) => {
      if (address.path === "ACME_MAIN") throw new Error("SENTINEL store failure");
      return write(address, value, options);
    });
    await withRuntime(async (client) => {
      const started = await authorize(client);
      const { runId } = await client.receiveConnection("acme", started.attempt, consent(started.url), {
        actor: "alice",
      });
      expect((await settled(client, runId))?.status).toBe("failed");
      expect(await client.connectionAttempt(started.attempt, { actor: "alice" })).toMatchObject({
        state: "failed",
        problem: "uncertain",
      });
      expect((await client.connections({ actor: "alice" }))[0]?.status).toBe("uncertain");
      expect(tokenRequests).toHaveBeenCalledTimes(1);
    }, store);
  }, 60_000);

  it("refuses OAuth before consent on a store that cannot keep grants", async () => {
    for (const store of [
      { ...memorySecretStore(), capabilities: { ...memorySecretStore().capabilities, conditionalWrites: "none" } },
      memorySecretStore({ writable: false }),
    ] as SecretStore[]) {
      const client = await SanomaClient.connect(config(store));
      try {
        await expect(authorize(client)).rejects.toMatchObject({ name: "SecretStoreError" });
      } finally {
        await client.close();
      }
    }
    expect(await (await pool.db()).select().from(connectionAttempts)).toEqual([]);
  });
});
