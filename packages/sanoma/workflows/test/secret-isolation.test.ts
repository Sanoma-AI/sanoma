import { randomUUID } from "node:crypto";
import { findSentinels, testDatabaseUrl } from "sanoma/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { postgresSecretStore } from "../src/credentials.ts";
import { lazyDb } from "../src/db.ts";
import { connectionHealth, connections, connectionSetups, credentials, ledger } from "../src/db/company.ts";
import {
  authenticationCredentials,
  type ConnectionSnapshot,
  defineAuthentication,
  defineConnection,
  defineConnectionRule,
  defineConnector,
  defineDriver,
  memorySecretStore,
  SanomaClient,
  type SanomaConfig,
  SecretStoreError,
  withSetup,
} from "../src/index.ts";
import { generateSecret, secret } from "../src/secret.ts";

// Needs Postgres. Whose bundle a call can read: two companies, each on its own database under its
// own key, with the same connection names; two accounts of one vendor in one company; and a
// person's dynamic account. A bundle is an account's name, then a sentinel the database must never
// hold in the clear: the driver answers with the account its bundle names, so a call says whose it
// read. The built-in store seals each under `SANOMA_SECRETS_KEY`, bound to its namespace and name.

const key = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.string(),
  storage: { writable: true, maxBytes: 512, conditionalWrites: true },
  verify: async (bundle) => ({ account: bundle.split("|")[0]!, scopes: ["read"] }),
});
const ops = defineConnector("mail", {
  message: { read: { effect: "read", input: z.object({}), output: z.object({ account: z.string() }) } },
});
const mail = withSetup(ops, {
  authentication: { key },
  driver: () =>
    defineDriver(
      ops,
      {
        message: {
          read: async (_input, call) => ({ account: authenticationCredentials("key", key, call).split("|")[0]! }),
        },
      },
      { authentication: ["key"] },
    ),
});
const support = defineConnection(mail, { name: "support", method: "key", credentials: secret("SUPPORT") });
const sales = defineConnection(mail, { name: "sales", method: "key", credentials: secret("SALES") });
const customer = defineConnectionRule(mail, { name: "customer", method: "key", createBy: ["alice", "bob"] });

const sentinels = new Set<string>();
const bundleOf = (account: string) => {
  const value = `SENTINEL-${account}-${randomUUID()}`;
  sentinels.add(value);
  return `${account}|${value}`;
};

/** A company: its own database, and its own key, which the test puts in the environment while it acts as that company. */
function company(name: string) {
  const databaseUrl = testDatabaseUrl(`secret_isolation_${name}`);
  return {
    databaseUrl,
    pool: lazyDb(databaseUrl, `secret-isolation-${name}`),
    key: generateSecret(),
    config: {
      databaseUrl,
      workflows: [],
      connectors: [mail],
      connections: [support, sales],
      connectionRules: [customer],
    } satisfies SanomaConfig,
  };
}
const a = company("a");
const b = company("b");
/** Acts as `c`: its key is the environment's. */
const as = (c: typeof a) => vi.stubEnv("SANOMA_SECRETS_KEY", c.key);

/** Connects `connection` in `client`'s company with `bundle`, through the intake. */
async function connectWith(client: SanomaClient, connection: typeof support, bundle: string) {
  const review = await client.previewConnection({ connection }, bundle, { actor: "alice", id: randomUUID() });
  return client.connectConnection(review, bundle, { actor: "alice" });
}
const read = (client: SanomaClient, connection: typeof support, actor = "alice") =>
  client.call("mail.message.read", {}, { actor, connection });
/** The sealed row of `name` in a company's database. */
const sealed = async (c: typeof a, name: string) =>
  (await (await c.pool.db()).select().from(credentials).where(eq(credentials.name, name)))[0]!;
const replaceSealed = async (c: typeof a, name: string, value: string) =>
  (await c.pool.db())
    .update(credentials)
    .set({ value })
    .where(and(eq(credentials.namespace, "default"), eq(credentials.name, name)));

beforeAll(async () => {
  for (const c of [a, b]) {
    as(c);
    await (await SanomaClient.connect(c.config)).close();
  }
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  for (const c of [a, b])
    await (
      await c.pool.db()
    ).execute(sql`TRUNCATE ${connections}, ${connectionSetups}, ${connectionHealth}, ${credentials}, ${ledger}`);
});
afterEach(async (test) => {
  vi.unstubAllEnvs();
  for (const c of [a, b]) test.expect(await findSentinels(c.databaseUrl, sentinels)).toEqual([]);
});
afterAll(async () => {
  await Promise.all([a.pool.close(), b.pool.close()]);
});

describe("two companies", () => {
  it("each call reads its own company's bundle, and a sealed row copied from the other is refused", async () => {
    as(a);
    const first = await SanomaClient.connect(a.config);
    as(b);
    const second = await SanomaClient.connect(b.config);
    try {
      as(a);
      await connectWith(first, support, bundleOf("a-support"));
      as(b);
      await connectWith(second, support, bundleOf("b-support"));
      expect(await read(second, support)).toEqual({ account: "b-support" });
      as(a);
      expect(await read(first, support)).toEqual({ account: "a-support" });

      // Company b's row, as a copy of its database would carry it, put in place of a's.
      await replaceSealed(a, "SUPPORT", (await sealed(b, "SUPPORT")).value);
      const refused = await read(first, support).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(Error);
      expect(JSON.stringify({ refused, message: (refused as Error).message })).not.toMatch(/b-support|SENTINEL/);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("is kept apart by the key and the namespace a value is sealed under, not by the database", async () => {
    // What a sealed value is bound to: the key, its namespace and its name. A store on another
    // database under the same key and namespace opens a copied row; that is why each company's key is its own.
    as(a);
    const theirs = postgresSecretStore(() => b.pool.db());
    const ours = postgresSecretStore(() => a.pool.db());
    const value = bundleOf("shared-key");
    await theirs.write({ namespace: "default", path: "SUPPORT" }, value, { expectedVersion: null, by: "test" });
    const copied = (await sealed(b, "SUPPORT")).value;
    await (await a.pool.db()).insert(credentials).values([
      { namespace: "default", name: "SUPPORT", value: copied, version: randomUUID(), setBy: "copy" },
      { namespace: "elsewhere", name: "SUPPORT", value: copied, version: randomUUID(), setBy: "copy" },
    ]);
    expect((await ours.read({ namespace: "default", path: "SUPPORT" }))?.value).toBe(value);
    await expect(ours.read({ namespace: "elsewhere", path: "SUPPORT" })).rejects.toBeInstanceOf(SecretStoreError);
    as(b);
    await expect(ours.read({ namespace: "default", path: "SUPPORT" })).rejects.toBeInstanceOf(SecretStoreError);
  });
});

describe("accounts of one vendor in one company", () => {
  it("calls each with its own bundle, and refuses one sealed under the other's name", async () => {
    as(a);
    const client = await SanomaClient.connect(a.config);
    try {
      await connectWith(client, support, bundleOf("support"));
      await connectWith(client, sales, bundleOf("sales"));
      expect(await Promise.all([read(client, support), read(client, sales)])).toEqual([
        { account: "support" },
        { account: "sales" },
      ]);
      // Sales' sealed bundle moved to support's name: bound to its own name, it opens nowhere else.
      await replaceSealed(a, "SUPPORT", (await sealed(a, "SALES")).value);
      const refused = await read(client, support).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(Error);
      expect(JSON.stringify({ refused, message: (refused as Error).message })).not.toMatch(/"sales"|SENTINEL/);
      expect(await read(client, sales)).toEqual({ account: "sales" });
    } finally {
      await client.close();
    }
  });

  it("refuses another person's dynamic account before reading any store", async () => {
    const store = memorySecretStore();
    const client = await SanomaClient.connect({ ...a.config, secrets: { store } });
    try {
      const created = (await client.call(
        "sanoma.connection.create",
        { rule: "mail/customer", account: "alice-customer", scopes: ["read"] },
        { actor: "alice", id: randomUUID() },
      )) as ConnectionSnapshot;
      const connection = { vendor: "mail", $connection: created.id } as unknown as typeof support;
      await connectWith(client, connection, bundleOf("alice-customer"));
      expect(await read(client, connection)).toEqual({ account: "alice-customer" });
      const reads = vi.spyOn(store, "read");
      await expect(read(client, connection, "bob")).rejects.toMatchObject({
        code: "policy_denied",
      });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
