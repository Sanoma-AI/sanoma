import { randomUUID } from "node:crypto";
import { findSentinels, testDatabaseUrl } from "sanoma/testing";
import { runEnded } from "sanoma/testing/host";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionHealth, connections, connectionSetups, credentials, ledger } from "../src/db/company.ts";
import { workflowStatus } from "../src/db/dbos.ts";
import { lazyDb } from "../src/db.ts";
import {
  AuthenticationError,
  authenticationCredentials,
  defineAuthentication,
  defineConnection,
  defineConnector,
  defineDriver,
  defineWorkflow,
  DriverError,
  resolveSecrets,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  withSetup,
} from "../src/index.ts";
import { secret } from "../src/secret.ts";

// Needs Postgres. A credential's value is a sentinel, and after each test no column of the
// company's database (its tables, DBOS's, the store's) holds one (`findSentinels`): a driver that
// throws what it read, by a workflow's call and a direct one, through a `secret()` marker, the
// environment it declares and a named connection's bundle; a connection's intake, Test and a
// verifier that repeats the credential. The built-in store keeps each value sealed, so the
// credentials table is read too.

const databaseUrl = testDatabaseUrl("secret_leakage");
const pool = lazyDb(databaseUrl, "secret-leakage-tests");
const sentinels = new Set<string>();
const planted = (what: string) => {
  const value = `SENTINEL-${what}-${randomUUID()}`;
  sentinels.add(value);
  return value;
};

/** How the driver fails with what it read: in its message, an error's cause, or a property an SDK keeps the request in. */
const Failure = z.enum(["message", "cause", "property"]);
type Failure = z.infer<typeof Failure>;
const fail = (how: Failure, value: string): never => {
  if (how === "message") throw new DriverError(`vault refused the token ${value}`, { retryable: false, status: 401 });
  if (how === "cause") throw new Error("vault's SDK failed", { cause: new Error(`Authorization: Bearer ${value}`) });
  throw Object.assign(new Error("vault's SDK failed"), {
    retryable: false,
    request: { headers: { authorization: `Bearer ${value}` } },
  });
};

const marker = z.object({ $secret: z.string() });
/** The `call.secrets` each `token.pair` call was given. */
const given: unknown[] = [];
const vaultOps = defineConnector("vault", {
  token: {
    use: { effect: "read", input: z.object({ token: marker, how: Failure }), output: z.object({}) },
    pair: { effect: "read", input: z.object({ short: marker, long: marker }), output: z.object({}) },
  },
});
const vault = withSetup(vaultOps, {
  driver: () =>
    defineDriver(vaultOps, {
      token: {
        use: async (input, call) => fail(input.how, (await resolveSecrets(input, call.secrets)).token),
        pair: async (input, call) => {
          given.push(call.secrets);
          const { long } = await resolveSecrets(input, call.secrets);
          return fail("message", long);
        },
      },
    }),
});
/** A driver that reads its environment, as one without named accounts does. */
const legacyOps = defineConnector("legacy", {
  token: { use: { effect: "read", input: z.object({ how: Failure }), output: z.object({}) } },
});
const legacy = withSetup(legacyOps, {
  driver: () =>
    defineDriver(
      legacyOps,
      { token: { use: async ({ how }) => fail(how, process.env.LEGACY_TOKEN!) } },
      { env: z.object({ LEGACY_TOKEN: z.string().describe("legacy's token") }) },
    ),
});

const key = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.string(),
  storage: { writable: true, maxBytes: 512, conditionalWrites: true },
  verify: async (value) => {
    // A verifier's refusal holding the response it refused, the credential in it.
    if (value.includes("refused"))
      throw Object.assign(new AuthenticationError("rejected"), { response: { echoed: value } });
    if (value.includes("throws")) throw new Error(`the vendor answered 401 for ${value}`);
    return { account: "org-1", scopes: ["read"] };
  },
});
const mailOps = defineConnector("mail", {
  message: { read: { effect: "read", input: z.object({ how: Failure }), output: z.object({}) } },
});
const mail = withSetup(mailOps, {
  authentication: { key },
  driver: () =>
    defineDriver(
      mailOps,
      { message: { read: async ({ how }, call) => fail(how, authenticationCredentials("key", key, call)) } },
      { authentication: ["key"] },
    ),
});
const support = defineConnection(mail, { name: "support", method: "key", credentials: secret("SUPPORT") });

const useToken = defineWorkflow({
  name: "use-token",
  trigger: "manual",
  input: z.object({ how: Failure }),
  uses: [vault.token.use],
  run: async (ctx, { how }) => ctx.vault.token.use({ token: secret("VAULT_TOKEN"), how }),
});
const useEnv = defineWorkflow({
  name: "use-env",
  trigger: "manual",
  input: z.object({ how: Failure }),
  uses: [legacy.token.use],
  run: async (ctx, { how }) => ctx.legacy.token.use({ how }),
});
const readMail = defineWorkflow({
  name: "read-mail",
  trigger: "manual",
  input: z.object({ how: Failure }),
  uses: [mail.message.read],
  run: async (ctx, { how }) => ctx.mail.message.read({ how }, { connection: support }),
});

/** The built-in store (Postgres, sealed under the test run's key) and the Postgres ledger: everything in the one database. */
const config: SanomaConfig = {
  databaseUrl,
  workflows: [useToken, useEnv, readMail],
  connectors: [vault, legacy, mail],
  connections: [support],
};

let client: SanomaClient;
beforeAll(async () => {
  client = await SanomaClient.connect(config);
  const db = await pool.db();
  await db.execute(sql`TRUNCATE ${connections}, ${connectionSetups}, ${connectionHealth}, ${credentials}, ${ledger}`);
  await db.execute(sql`TRUNCATE ${workflowStatus} CASCADE`);
});
afterAll(async () => {
  await client.close();
  await pool.close();
});
afterEach(async (test) => {
  vi.unstubAllEnvs();
  test.expect(await findSentinels(databaseUrl, sentinels)).toEqual([]);
});

const hows = Failure.options;
/** What the caller is told, and what a browser would be sent: the error as JSON, with its message and stack. */
const told = (error: unknown) =>
  JSON.stringify({
    error,
    message: (error as Error).message,
    stack: (error as Error).stack,
    cause: (error as Error).cause,
  });

describe("a driver's error, with what it read in it", () => {
  it("is recorded and thrown without the secret a marker resolved, by a workflow's call", async () => {
    const token = planted("token");
    await client.setSecret("VAULT_TOKEN", token, { by: "alice" });
    const worker = await startWorker(config);
    try {
      const failures = new Map<Failure, unknown>();
      for (const how of hows) {
        const run = await client.start(useToken, { how }, { startedBy: "alice" });
        const ended = await runEnded(client, run, 20_000);
        expect(ended?.status).toBe("failed");
        expect(told(ended)).not.toContain(token);
        // The call's failure is in the ledger, its message the driver's with the value taken out.
        const called = (await client.ledger(run)).find((r) => r.type === "op.called");
        expect(called).toMatchObject({ op: "vault.token.use", error: { code: "driver_failed" } });
        failures.set(how, called);
      }
      expect(failures.get("message")).toMatchObject({
        error: { message: "vault refused the token [redacted]", status: 401 },
      });
    } finally {
      await worker.stop();
    }
  });

  it("is recorded and thrown without it by a direct call, as a browser would be answered", async () => {
    const token = planted("token");
    await client.setSecret("VAULT_TOKEN", token, { by: "alice" });
    for (const how of hows) {
      const error = await client
        .call("vault.token.use", { token: secret("VAULT_TOKEN"), how }, { actor: "alice" })
        .catch((e: unknown) => e);
      // Retried only when the driver's own error says so; its status kept.
      expect(error).toMatchObject({ code: "driver_failed", retryable: false });
      expect(error).not.toHaveProperty("cause");
      expect(told(error)).not.toContain(token);
    }
  });

  it("is cleared of a value that begins another, whole, and the driver's store is the same at each call", async () => {
    const long = planted("long");
    const short = long.slice(0, 20);
    sentinels.add(short);
    await client.setSecret("VAULT_SHORT", short, { by: "alice" });
    await client.setSecret("VAULT_LONG", long, { by: "alice" });
    given.length = 0;
    for (let i = 0; i < 2; i++) {
      const error = await client
        .call("vault.token.pair", { short: secret("VAULT_SHORT"), long: secret("VAULT_LONG") }, { actor: "alice" })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ message: "vault refused the token [redacted]" });
    }
    // A driver keeping state by its store (the change driver's hosts) finds it again.
    expect(given[0]).toBe(given[1]);
  });

  it("is cleared of the environment the driver declares", async () => {
    const token = planted("env");
    vi.stubEnv("LEGACY_TOKEN", token);
    for (const how of hows) {
      const error = await client.call("legacy.token.use", { how }, { actor: "alice" }).catch((e: unknown) => e);
      expect(told(error)).not.toContain(token);
    }
    const worker = await startWorker(config);
    try {
      const run = await client.start(useEnv, { how: "message" }, { startedBy: "alice" });
      const ended = await runEnded(client, run, 20_000);
      expect(ended?.status).toBe("failed");
      expect(told(ended)).not.toContain(token);
    } finally {
      await worker.stop();
    }
  });

  it("names nothing of a named connection's bundle, by a workflow's call and a direct one", async () => {
    const bundle = planted("bundle");
    const review = await client.previewConnection({ connection: support }, bundle, {
      actor: "alice",
      id: randomUUID(),
    });
    await client.connectConnection(review, bundle, { actor: "alice" });
    for (const how of hows) {
      const error = await client
        .call("mail.message.read", { how }, { actor: "alice", connection: support })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ message: "mail operation failed" });
      expect(told(error)).not.toContain(bundle);
    }
    const worker = await startWorker(config);
    try {
      const run = await client.start(readMail, { how: "cause" }, { startedBy: "alice" });
      expect((await runEnded(client, run, 20_000))?.status).toBe("failed");
    } finally {
      await worker.stop();
    }
  });
});

describe("a connection's own operations", () => {
  it("records no credential a verifier refused or threw on, at intake and at Test", async () => {
    for (const what of ["refused", "throws"]) {
      const credential = planted(what);
      const error = await client
        .previewConnection({ connection: support }, credential, { actor: "alice", id: randomUUID() })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(told(error)).not.toContain(credential);
    }
    // Connected with a good one, then the vendor turns on it: Test fails, saying nothing of it.
    const good = planted("good");
    const review = await client.previewConnection({ connection: support }, good, { actor: "alice", id: randomUUID() });
    await client.connectConnection(review, good, { actor: "alice" });
    const turned = `${good}-throws`;
    sentinels.add(turned);
    await client.setSecret("SUPPORT", turned, { by: "alice" });
    const tested = await client
      .call("sanoma.connection.test", { connection: support }, { actor: "alice" })
      .catch((e: unknown) => e);
    expect(told(tested)).not.toContain(good);
  });
});
