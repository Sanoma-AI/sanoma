import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  connectionAttempts,
  connectionHealth,
  connectionRenewals,
  connections,
  connectionSetups,
  credentials,
  ledger,
  secretMoves,
} from "../src/db/company.ts";
import { workflowStatus } from "../src/db/dbos.ts";
import {
  AuthenticationError,
  authenticationCredentials,
  defineAuthentication,
  defineConnection,
  defineConnector,
  defineDriver,
  DriverError,
  memorySecretStore,
  SanomaClient,
  type SanomaConfig,
  type SecretStore,
  startWorker,
  withSetup,
} from "../src/index.ts";
import { lazyDb } from "../src/db.ts";
import { ConnectionRenewals } from "../src/renewal.ts";
import { secret } from "../src/secret.ts";
import { rootWith } from "./harness.ts";

// An OAuth grant's life after consent, over a controllable provider (msw) and the company's own
// Postgres: renewal near expiry and on a declared 401, coordinated by the connection's lease across
// "processes" (each a client with its own pools and, with the built-in store, its own store
// handle on the same tables), a holder that stopped before or after sending, a renewed grant the
// store did not keep, rotation, revocation and disconnect. Every token is a sentinel the last
// check looks for in the ledger, DBOS's tables and the runtime's lifecycle rows.

const PROVIDER = "https://oauth.lifecycle.test";
const API = "https://api.lifecycle.test";
const CLIENT = { clientId: "lifecycle-client", clientSecret: "SENTINEL-client-secret" };
const REDIRECT = "https://app.example.test/connect/acme/callback";

const sentinels = new Set<string>([CLIENT.clientSecret]);
/** What the provider issued: codes by code, access tokens to their account, refresh tokens and whether spent. */
const codes = new Map<string, { challenge: string; redirectUri: string }>();
const access = new Set<string>();
const refresh = new Map<string, { spent: boolean }>();
/** The refresh tokens the provider was sent, in order. */
const refreshed: string[] = [];
const revocations: string[] = [];
const provider = {
  /** How long each issued access token lives, in seconds: under five minutes is due at once. */
  expiresIn: 3600,
  /** Refuses every refresh with `invalid_grant`, as for a revoked authorization. */
  refusing: false,
  /** Holds each refresh answer until it resolves. */
  hold: undefined as Promise<void> | undefined,
  /** Runs before a refresh answers, as another writer would meanwhile. */
  during: undefined as (() => Promise<void>) | undefined,
  /** Access tokens `/thing` answers 401 for although `/me` takes them, and a status for every call. */
  thingRejects: new Set<string>(),
  thingStatus: undefined as number | undefined,
  /** Holds `/me` (the verifier) until it resolves. */
  holdMe: undefined as Promise<void> | undefined,
};
const thingCalls = vi.fn<() => void>();

function issue() {
  const token = `SENTINEL-access-${randomUUID()}`;
  const renewal = `SENTINEL-refresh-${randomUUID()}`;
  sentinels.add(token).add(renewal);
  access.add(token);
  refresh.set(renewal, { spent: false });
  return {
    access_token: token,
    refresh_token: renewal,
    token_type: "Bearer",
    expires_in: provider.expiresIn,
    scope: "read",
  };
}

const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

const server = setupServer(
  http.post(`${PROVIDER}/token`, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "refresh_token") {
      const given = form.get("refresh_token") ?? "";
      refreshed.push(given);
      await provider.hold;
      await provider.during?.();
      const known = refresh.get(given);
      if (provider.refusing || !known || known.spent)
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      known.spent = true;
      return HttpResponse.json(issue());
    }
    const code = codes.get(form.get("code") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (!code || code.challenge !== challenge) return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    codes.delete(form.get("code")!);
    return HttpResponse.json(issue());
  }),
  http.post(`${PROVIDER}/revoke`, async ({ request }) => {
    revocations.push(new URLSearchParams(await request.text()).get("token") ?? "");
    return new HttpResponse(null, { status: 200 });
  }),
  http.get(`${API}/me`, async ({ request }) => {
    await provider.holdMe;
    return access.has(bearer(request))
      ? HttpResponse.json({ account: "org-1" })
      : HttpResponse.json({}, { status: 401 });
  }),
  http.get(`${API}/thing`, ({ request }) => {
    thingCalls();
    const token = bearer(request);
    if (provider.thingStatus) return HttpResponse.json({}, { status: provider.thingStatus });
    return access.has(token) && !provider.thingRejects.has(token)
      ? HttpResponse.json({ thing: "of org-1" })
      : HttpResponse.json({}, { status: 401 });
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
    tokenRejected: [401],
    // A day: a grant nobody uses is renewed by the worker before its refresh token lapses.
    refreshTokenLifetime: 86_400,
  },
  async verify(grant) {
    const res = await fetch(`${API}/me`, { headers: { authorization: `Bearer ${grant.accessToken}` } });
    if (!res.ok) throw new AuthenticationError("rejected");
    const { account } = (await res.json()) as { account: string };
    return { account, scopes: grant.scopes ?? [], ...(grant.expiresAt && { expiresAt: grant.expiresAt }) };
  },
  async revoke(grant) {
    const res = await fetch(`${PROVIDER}/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: grant.refreshToken ?? grant.accessToken }),
    });
    if (!res.ok) throw new Error("not revoked");
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
            if (!res.ok) throw new DriverError(`acme answered ${res.status}`, { retryable: false, status: res.status });
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
const ref = { vendor: "acme", $connection: main.$connection };

const databaseUrl = testDatabaseUrl("oauth_lifecycle");
const pool = lazyDb(databaseUrl, "oauth-lifecycle-tests");
/** The built-in store (Postgres) unless one is given: each config's handle on it is its own. */
const config = (options: { store?: SecretStore; root?: string } = {}): SanomaConfig => ({
  databaseUrl,
  workflows: [],
  connectors: [acme],
  connections: [main],
  secrets: options.store ? { store: options.store } : {},
  ...(options.root && { root: options.root }),
});

/** Clients that stand for processes of their own, each closed after the test. */
const opened: SanomaClient[] = [];
async function processOf(options: Parameters<typeof config>[0] = {}): Promise<SanomaClient> {
  const client = await SanomaClient.connect(config(options));
  opened.push(client);
  return client;
}

/** Connects `main` by consent through a worker, which then stops: no background renewal runs after. */
async function connect(options: Parameters<typeof config>[0] = {}): Promise<SanomaClient> {
  const worker = await startWorker(config(options));
  const client = await processOf(options);
  try {
    const started = await client.authorizeConnection(
      { connection: ref },
      { actor: "alice", id: randomUUID(), redirectUri: REDIRECT, client: CLIENT },
    );
    const url = new URL(started.url);
    const code = `SENTINEL-code-${randomUUID()}`;
    sentinels.add(code).add(url.searchParams.get("state")!);
    codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: REDIRECT });
    const { runId } = await client.receiveConnection(
      "acme",
      started.attempt,
      new URLSearchParams({ code, state: url.searchParams.get("state")! }),
      { actor: "alice" },
    );
    const run = await waitFor(
      () => client.run(runId),
      (r) => r?.status === "finished" || r?.status === "failed",
      20_000,
    );
    expect(run?.status).toBe("finished");
  } finally {
    await worker.stop();
  }
  return client;
}

const read = (client: SanomaClient) => client.call("acme.thing.read", {}, { actor: "alice", connection: main });
const card = async (client: SanomaClient) => (await client.connections({ actor: "alice" }))[0]!;
/** Moves `acme/main`'s scheduled renewal into the past, as if its time had come. */
const comeDue = async () =>
  (await pool.db())
    .update(connectionRenewals)
    .set({ dueAt: sql`now() - interval '1 second'` })
    .where(eq(connectionRenewals.connectionId, "acme/main"));
const renewalRow = async () =>
  (
    await (await pool.db()).select().from(connectionRenewals).where(eq(connectionRenewals.connectionId, "acme/main"))
  )[0];

beforeAll(async () => {
  server.listen({ onUnhandledFrame: "bypass" });
  await (await SanomaClient.connect(config())).close();
});
afterAll(async () => {
  server.close();
  await pool.close();
});
beforeEach(async () => {
  const db = await pool.db();
  await db.execute(
    sql`TRUNCATE ${connections}, ${connectionSetups}, ${connectionHealth}, ${connectionAttempts}, ${connectionRenewals}, ${credentials}, ${ledger}`,
  );
  await db.execute(sql`TRUNCATE ${workflowStatus} CASCADE`);
  Object.assign(provider, {
    expiresIn: 3600,
    refusing: false,
    hold: undefined,
    during: undefined,
    thingStatus: undefined,
    holdMe: undefined,
  });
  provider.thingRejects.clear();
  refreshed.length = 0;
  revocations.length = 0;
  thingCalls.mockClear();
});
afterEach(async (test) => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((client) => client.close()));
  // No token, code or client secret in the ledger, DBOS's tables or the lifecycle rows (the
  // credentials table holds them sealed, so it is not read).
  const text = await (
    await pool.db()
  ).execute<{ row: string }>(sql`
    SELECT t::text AS row FROM dbos.workflow_status t
    UNION ALL SELECT t::text FROM dbos.operation_outputs t
    UNION ALL SELECT t::text FROM dbos.workflow_events t
    UNION ALL SELECT t::text FROM dbos.notifications t
    UNION ALL SELECT t::text FROM ${ledger} t
    UNION ALL SELECT t::text FROM ${connections} t
    UNION ALL SELECT t::text FROM ${connectionHealth} t
    UNION ALL SELECT t::text FROM ${connectionRenewals} t
    UNION ALL SELECT t::text FROM ${connectionAttempts} t`);
  const history = text.rows.map((r) => r.row).join("\n");
  for (const sentinel of sentinels) test.expect(history).not.toContain(sentinel);
});

describe("OAuth renewal", () => {
  it("renews a due grant once when two processes use it at the same time; both call with the new grant", async () => {
    provider.expiresIn = 60;
    await connect();
    const [a, b] = [await processOf(), await processOf()];
    let release!: () => void;
    provider.hold = new Promise((resolve) => (release = resolve));
    const calls = [read(a), read(b)];
    await waitFor(
      async () => refreshed.length,
      (n) => n === 1,
      10_000,
    );
    // The second process waits on the lease rather than sending the same refresh token.
    provider.expiresIn = 3600;
    release();
    expect(await Promise.all(calls)).toEqual([{ thing: "of org-1" }, { thing: "of org-1" }]);
    expect(refreshed).toHaveLength(1);
    const renewed = await card(a);
    expect(renewed.renewal).toMatchObject({ outcome: "refreshed" });
    expect(Date.parse(renewed.renewal!.dueAt!)).toBeGreaterThan(Date.now() + 3_000_000);
    expect(Date.parse(renewed.health!.expiresAt!)).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await renewalRow()).toMatchObject({ holder: null, sentAt: null });
    // The test reports when the grant expires and when it was last renewed.
    const tested = await a.call("sanoma.connection.test", { connection: ref }, { actor: "alice" });
    expect(tested).toMatchObject({ state: "connected", refreshedAt: renewed.renewal!.refreshedAt });
    expect(Date.parse((tested as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now() + 3_000_000);
  }, 60_000);

  it("renews on a status the method declares as a rejected token and calls once more; another status is not repeated", async () => {
    await connect();
    const client = await processOf();
    for (const token of access) provider.thingRejects.add(token);
    expect(await read(client)).toEqual({ thing: "of org-1" });
    expect(refreshed).toHaveLength(1);
    expect(thingCalls).toHaveBeenCalledTimes(2);
    provider.thingStatus = 403;
    await expect(read(client)).rejects.toMatchObject({ code: "driver_failed", status: 403 });
    expect(thingCalls).toHaveBeenCalledTimes(3);
    expect(refreshed).toHaveLength(1);
    // Still refused once renewed: the second answer is the call's, and no third is sent.
    provider.thingStatus = 401;
    await expect(read(client)).rejects.toMatchObject({ code: "driver_failed", status: 401 });
    expect(thingCalls).toHaveBeenCalledTimes(5);
    expect(refreshed).toHaveLength(2);
  }, 60_000);

  it("takes over a lease whose holder stopped before sending, and marks uncertain one whose holder stopped after", async () => {
    provider.expiresIn = 60;
    await connect();
    const client = await processOf();
    const db = await pool.db();
    const lapsed = (sent: boolean) =>
      db
        .update(connectionRenewals)
        .set({
          holder: "a-process-that-stopped",
          leaseUntil: sql`now() - interval '1 second'`,
          sentAt: sent ? sql`now() - interval '2 seconds'` : null,
        })
        .where(eq(connectionRenewals.connectionId, "acme/main"));
    // Stopped before it sent anything: renewed as if it had never begun.
    await lapsed(false);
    expect(await read(client)).toEqual({ thing: "of org-1" });
    expect(refreshed).toHaveLength(1);
    // Stopped after sending: the refresh token may be spent with nothing stored, so it is never sent again.
    await lapsed(true);
    await expect(read(client)).rejects.toMatchObject({ cause: { problem: "uncertain" } });
    expect(refreshed).toHaveLength(1);
    expect(await card(client)).toMatchObject({ status: "uncertain", renewal: { outcome: "uncertain" } });
    await expect(read(client)).rejects.toThrow(/missing or disconnected/);
    expect(refreshed).toHaveLength(1);
  }, 60_000);

  it("leaves the connection uncertain when the provider renewed the grant and the store did not keep it", async () => {
    provider.expiresIn = 60;
    const store = memorySecretStore();
    await connect({ store });
    const client = await processOf({ store });
    const write = store.write.bind(store);
    vi.spyOn(store, "write").mockImplementation(async (address, value, options) => {
      if (address.path === "ACME_MAIN") throw new Error("SENTINEL store failure");
      return write(address, value, options);
    });
    await expect(read(client)).rejects.toMatchObject({ cause: { problem: "uncertain" } });
    expect(refreshed).toHaveLength(1);
    expect((await card(client)).status).toBe("uncertain");
    // No competing retry with the old refresh token: the account waits for Reconnect.
    await expect(read(client)).rejects.toThrow(/missing or disconnected/);
    expect(refreshed).toHaveLength(1);
  }, 60_000);

  it("never writes over a grant another writer replaced while it renewed", async () => {
    provider.expiresIn = 60;
    const store = memorySecretStore();
    await connect({ store });
    const client = await processOf({ store });
    const address = { namespace: "default", path: "ACME_MAIN" };
    provider.during = async () => {
      const current = await store.read(address);
      await store.write(address, current!.value, { expectedVersion: current!.version, by: "elsewhere" });
    };
    await expect(read(client)).rejects.toMatchObject({ cause: { problem: "uncertain" } });
    expect((await store.read(address))?.updatedBy).toBe("elsewhere");
    expect((await card(client)).status).toBe("uncertain");
  }, 60_000);

  it("keeps using the grant when the token endpoint could not be reached, and marks uncertain one sent with no answer", async () => {
    provider.expiresIn = 60;
    await connect();
    const client = await processOf();
    const original = globalThis.fetch;
    const failing = (code: string) =>
      vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input, init) =>
          String(input instanceof Request ? input.url : input) === `${PROVIDER}/token`
            ? Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }))
            : original(input, init),
        );
    // Refused before anything was sent: the access token, still valid, keeps working; asked again later.
    failing("ECONNREFUSED");
    expect(await read(client)).toEqual({ thing: "of org-1" });
    expect(await card(client)).toMatchObject({ status: "connected", renewal: { outcome: "unavailable" } });
    expect(refreshed).toHaveLength(0);
    // The connection dropped once the request was out: the refresh token may be spent, so never resent.
    vi.restoreAllMocks();
    failing("ECONNRESET");
    await expect(read(client)).rejects.toMatchObject({ cause: { problem: "uncertain" } });
    expect((await card(client)).status).toBe("uncertain");
  }, 60_000);

  it("fails a renewal closed when a store move pauses writes while it waits, keeping the valid grant, and renews once it lets go", async () => {
    provider.expiresIn = 60;
    await connect();
    const client = await processOf();
    // A move's transfer pausing writes at the built-in store's namespace, as `transfer` does: the
    // renewals locked, then the fence in. A renewal that comes meanwhile waits on the lock.
    const move = `migrate-store:${randomUUID()}`;
    const mover = lazyDb(databaseUrl, "mover");
    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let fencing!: () => void;
    const locked = new Promise<void>((resolve) => {
      fencing = resolve;
    });
    const transfer = (await mover.db()).transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${connectionRenewals} IN SHARE MODE`);
      await tx.insert(secretMoves).values({
        id: move,
        destinationName: "elsewhere",
        sourceStore: "postgres",
        sourceNamespace: "default",
        destinationStore: "memory",
        destinationNamespace: "default",
        phase: "transferring",
        fenced: true,
        retainHours: 0,
        startedBy: "alice",
      });
      fencing();
      await held;
    });
    try {
      await locked;
      const reading = read(client);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(refreshed).toHaveLength(0);
      commit();
      await transfer;
      // No refresh token spent with nowhere to keep its successor: the access token, still valid, serves.
      expect(await reading).toEqual({ thing: "of org-1" });
      expect(refreshed).toHaveLength(0);
      expect(await card(client)).toMatchObject({ status: "connected", renewal: { outcome: "unavailable" } });
      expect(await renewalRow()).toMatchObject({ holder: null, sentAt: null });
    } finally {
      commit();
      await transfer.catch(() => {});
      await mover.close();
      await (await pool.db()).delete(secretMoves).where(eq(secretMoves.id, move));
    }
    expect(await read(client)).toEqual({ thing: "of org-1" });
    expect(refreshed).toHaveLength(1);
    expect(await card(client)).toMatchObject({ status: "connected", renewal: { outcome: "refreshed" } });
  }, 60_000);

  it("rotates the refresh token, and treats a refused one as revoked with nothing more scheduled", async () => {
    provider.expiresIn = 60;
    await connect();
    const client = await processOf();
    await read(client);
    await read(client);
    expect(refreshed).toHaveLength(2);
    expect(new Set(refreshed).size).toBe(2);
    provider.refusing = true;
    await expect(read(client)).rejects.toMatchObject({ cause: { problem: "revoked" } });
    expect(new Set(refreshed).size).toBe(3);
    expect((await card(client)).renewal).toEqual({ outcome: "revoked", refreshedAt: expect.any(String) });
    expect((await renewalRow())?.dueAt).toBeNull();
  }, 60_000);

  it("schedules a renewal only before the refresh token lapses, and gives a due one to one worker when two look at once", async () => {
    await connect();
    // Scheduled at nine tenths of the refresh token's day, not by the access token's hour.
    const scheduled = (await renewalRow())!.dueAt!.getTime() - Date.now();
    expect(scheduled).toBeGreaterThan(21 * 3_600_000);
    expect(scheduled).toBeLessThanOrEqual(86_400 * 900);
    await comeDue();
    const pools = [lazyDb(databaseUrl, "worker-a"), lazyDb(databaseUrl, "worker-b")];
    try {
      const [a, b] = pools.map((p) => new ConnectionRenewals(() => p.db()));
      const taken = (await Promise.all([a!.takeDue(), b!.takeDue()])).filter((t) => t !== undefined);
      expect(taken.map((t) => t.id)).toEqual(["acme/main"]);
      // Taken for a while: its due time moved on, so neither takes it again at once.
      expect(await a!.takeDue()).toBeUndefined();
      expect((await a!.nextDue())!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    } finally {
      await Promise.all(pools.map((p) => p.close()));
    }
  }, 60_000);

  it("schedules the next renewal as the worker's deadline, and the worker renews it as the renewal agent", async () => {
    await connect();
    // Its time come, though the access token has an hour left: renewed now, and the next is due in about a day.
    await comeDue();
    const worker = await startWorker(config());
    try {
      await waitFor(
        async () => refreshed.length,
        (n) => n === 1,
        20_000,
      );
      const row = await waitFor(
        renewalRow,
        (r) => r?.outcome === "refreshed" && r.dueAt !== null && r.dueAt.getTime() > Date.now(),
        20_000,
      );
      await waitFor(
        async () => worker.deadlines.nextDeadline()?.getTime(),
        (at) => at === row!.dueAt!.getTime(),
        70_000,
      );
      const records = await (await pool.db()).select({ record: ledger.record }).from(ledger);
      expect(records.map((r) => r.record)).toContainEqual(
        expect.objectContaining({
          type: "op.called",
          op: "sanoma.connection.refresh",
          actor: expect.objectContaining({ id: "renewal" }),
        }),
      );
    } finally {
      await worker.stop();
    }
  }, 120_000);
});

describe("Disconnect and revoke", () => {
  it("disconnects across processes: drops the grant, keeps the application, and refuses a call verifying meanwhile", async () => {
    const store = memorySecretStore();
    const a = await connect({ store });
    const b = await processOf({ store });
    let release!: () => void;
    provider.holdMe = new Promise((resolve) => (release = resolve));
    const racing = read(b);
    const { revision } = await card(a);
    await a.call("sanoma.connection.disconnect", { connection: ref, expectedRevision: revision! }, { actor: "alice" });
    release();
    await expect(racing).rejects.toThrow(/changed|disconnected/);
    expect(await store.read({ namespace: "default", path: "ACME_MAIN" })).toBeUndefined();
    expect(await store.read({ namespace: "default", path: "ACME_APP" })).toBeDefined();
    expect(await renewalRow()).toBeUndefined();
    expect(revocations).toEqual([]);
    await expect(read(b)).rejects.toThrow(/missing or disconnected/);
  }, 60_000);

  it("revokes at the provider under policy, then disconnects; a denied revoke changes nothing", async () => {
    const store = memorySecretStore();
    const allowed = await connect({ store });
    const denied = await processOf({
      store,
      root: rootWith({
        "policies/revoke.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.connection.revoke", resource);`,
      }),
    });
    const { revision } = await card(allowed);
    const input = { connection: ref, expectedRevision: revision! };
    await expect(denied.call("sanoma.connection.revoke", input, { actor: "alice" })).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(revocations).toEqual([]);
    expect((await card(allowed)).status).toBe("connected");
    await allowed.call("sanoma.connection.revoke", input, { actor: "alice" });
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatch(/^SENTINEL-refresh-/);
    expect((await card(allowed)).status).toBe("disconnected");
    expect(await store.read({ namespace: "default", path: "ACME_MAIN" })).toBeUndefined();
    expect(await store.read({ namespace: "default", path: "ACME_APP" })).toBeDefined();
  }, 60_000);

  it("refuses a revoke or disconnect while a store move has paused writes, before anything changes", async () => {
    const store = memorySecretStore();
    const client = await connect({ store });
    const move = `migrate-store:${randomUUID()}`;
    await (await pool.db()).insert(secretMoves).values({
      id: move,
      destinationName: "elsewhere",
      sourceStore: "memory",
      sourceNamespace: "default",
      destinationStore: "postgres",
      destinationNamespace: "default",
      phase: "transferring",
      fenced: true,
      retainHours: 0,
      startedBy: "alice",
    });
    const { revision } = await card(client);
    const input = { connection: ref, expectedRevision: revision! };
    try {
      for (const op of ["sanoma.connection.revoke", "sanoma.connection.disconnect"])
        await expect(client.call(op, input, { actor: "alice" })).rejects.toThrow(/paused writes/);
      expect(revocations).toEqual([]);
      expect((await card(client)).status).toBe("connected");
      expect(await store.read({ namespace: "default", path: "ACME_MAIN" })).toBeDefined();
    } finally {
      await (await pool.db()).delete(secretMoves).where(eq(secretMoves.id, move));
    }
    await client.call("sanoma.connection.disconnect", input, { actor: "alice" });
    expect(await store.read({ namespace: "default", path: "ACME_MAIN" })).toBeUndefined();
  }, 60_000);
});
