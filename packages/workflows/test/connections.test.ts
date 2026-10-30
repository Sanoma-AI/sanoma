import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  defineAuthentication,
  encodeCredentials,
  authenticationCredentials,
  defineConnection,
  defineConnectionRule,
  defineConnector,
  defineResource,
  defineDriver,
  defineWorkflow,
  memoryLedger,
  memorySecretStore,
  SanomaClient,
  SecretAccess,
  startWorker,
  withSetup,
  type ConnectionSnapshot,
  type DriverFn,
} from "../src/index.ts";
import { connectionCatalog, ConnectionRegistry } from "../src/connection.ts";
import { secret } from "../src/secret.ts";
import { lazyPool } from "../src/db.ts";
import { visitorPrincipal } from "../src/shared.ts";
import { tree } from "./tree.ts";

const auth = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.string(),
  storage: { writable: false, maxBytes: 256, conditionalWrites: false },
  verify: async (value) => {
    const [account, scope] = value.split("|");
    return { account: account!, scopes: scope ? [scope] : [] };
  },
});
const ops = defineConnector("mail", {
  message: {
    read: {
      effect: "read",
      input: z.object({ id: z.string() }),
      output: z.object({ account: z.string() }),
      target: ({ id }: { id: string }) => `message/${id}`,
    },
  },
});
const mail = withSetup(ops, {
  authentication: { key: auth },
  driver: () =>
    defineDriver(
      ops,
      { message: { read: async (_input, call) => ({ account: call.connection!.account }) } },
      { authentication: ["key"] },
    ),
});
const support = defineConnection(mail, {
  name: "support",
  method: "key",
  credentials: secret("SUPPORT"),
  scopes: ["read"],
});
const sales = defineConnection(mail, { name: "sales", method: "key", credentials: secret("SALES"), scopes: ["read"] });
const customer = defineConnectionRule(mail, {
  name: "customer",
  method: "key",
  createBy: ["alice", "bob"],
  scopes: ["read"],
});
const probe = defineWorkflow({
  name: "connection-probe",
  trigger: "manual",
  input: z.object({}),
  uses: [mail.message.read],
  run: async (ctx) => ctx.mail.message.read({ id: "one" }, { connection: support }),
});
const dbUrl = testDatabaseUrl("connections");
const pool = lazyPool(dbUrl, "connections-test");
afterAll(() => pool.close());
const registry = () => new ConnectionRegistry(connectionCatalog([mail], [support, sales], [customer]), () => pool.db());
async function clear() {
  await (await pool.db()).query("DELETE FROM sanoma_connections");
}
const config = () => ({
  databaseUrl: dbUrl,
  connectors: [mail],
  connections: [support, sales],
  connectionRules: [customer],
  secrets: { store: memorySecretStore() },
  ledger: memoryLedger(),
  workflows: [probe],
});
const mailWith = (read: DriverFn<{ id: string }, { account: string }>) =>
  withSetup(mail, { driver: () => defineDriver(ops, { message: { read } }, { authentication: ["key"] }) });

async function bind(
  client: SanomaClient,
  connection = support,
  account = "support@example.test",
  expectedRevision: string | null = null,
) {
  await client.setSecret(connection.credentials!.$secret, encodeCredentials(auth, `${account}|read|private-key`), {
    by: "alice",
  });
  return (await client.call(
    "sanoma.connection.bind",
    { connection, account, scopes: ["read"], expectedRevision },
    { actor: { id: "alice" } },
  )) as ConnectionSnapshot;
}

describe("named connection identity", () => {
  it("rejects expiry and verifier exceptions without revealing their credential values", async () => {
    await clear();
    const invoked = vi.fn<DriverFn<{ id: string }, { account: string }>>(async () => ({ account: "should-not-run" }));
    const connector = withSetup(mailWith(invoked), {
      authentication: {
        key: defineAuthentication({
          kind: "api-key",
          version: 1,
          schema: z.string(),
          storage: { writable: false, maxBytes: 256, conditionalWrites: false },
          verify: async (key) => {
            if (key.includes("exception")) throw new Error(`SDK verifier: ${key}`);
            return { account: "support@example.test", scopes: ["read"], expiresAt: Date.now() - 1 };
          },
        }),
      },
    });
    const client = await SanomaClient.connect({ ...config(), connectors: [connector] });
    try {
      await bind(client);
      for (const key of ["expired-private-key", "exception-private-key"]) {
        await client.setSecret("SUPPORT", encodeCredentials(auth, key), { by: "alice" });
        const error = await client
          .call("mail.message.read", { id: "one" }, { actor: "alice", connection: support })
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ message: expect.stringContaining("Secret store: denied") });
        expect((error as Error).cause).toMatchObject({ name: "SecretStoreError" });
        expect((error as Error).cause).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("private-key");
      }
      expect(invoked).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("rechecks disconnection after a slow credential verification", async () => {
    await clear();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const invoked = vi.fn<DriverFn<{ id: string }, { account: string }>>(async () => ({ account: "should-not-run" }));
    const connector = withSetup(mailWith(invoked), {
      authentication: {
        key: defineAuthentication({
          kind: "api-key",
          version: 1,
          schema: z.string(),
          storage: { writable: false, maxBytes: 256, conditionalWrites: false },
          verify: async () => {
            entered.resolve();
            await release.promise;
            return { account: "support@example.test", scopes: ["read"] };
          },
        }),
      },
    });
    const client = await SanomaClient.connect({ ...config(), connectors: [connector] });
    let pending: Promise<unknown> | undefined;
    try {
      const bound = await bind(client);
      pending = client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: support });
      const rejected = pending.catch((error: unknown) => error);
      await entered.promise;
      await client.call(
        "sanoma.connection.disconnect",
        { connection: support, expectedRevision: bound.revision },
        { actor: "alice" },
      );
      release.resolve();
      expect(await rejected).toMatchObject({ message: expect.stringContaining("disconnected") });
      expect(invoked).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending?.catch(() => undefined);
      await client.close();
    }
  });
  it("isolates concurrent account calls and lets an in-flight call finish on its original version", async () => {
    await clear();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: { id: string; key: string; version: string | undefined }[] = [];
    const connector = mailWith(async (input, call) => {
      const key = authenticationCredentials("key", auth, call);
      seen.push({ id: input.id, key, version: call.authentication?.credentialVersion });
      if (input.id === "held") {
        entered.resolve();
        await release.promise;
      }
      expect(authenticationCredentials("key", auth, call)).toBe(key);
      return { account: key.split("|")[0]! };
    });
    const client = await SanomaClient.connect({ ...config(), connectors: [connector] });
    let held: Promise<unknown> | undefined;
    try {
      await bind(client);
      await bind(client, sales, "sales@example.test");
      held = client.call("mail.message.read", { id: "held" }, { actor: "alice", connection: support });
      await entered.promise;
      await client.setSecret("SUPPORT", encodeCredentials(auth, "support@example.test|read|rotated-private"), {
        by: "alice",
      });
      expect(
        await Promise.all(
          [support, sales].map((connection) =>
            client.call("mail.message.read", { id: "next" }, { actor: "alice", connection }),
          ),
        ),
      ).toEqual([{ account: "support@example.test" }, { account: "sales@example.test" }]);
      release.resolve();
      expect(await held).toEqual({ account: "support@example.test" });
      expect(seen.map((s) => s.key)).toEqual(
        expect.arrayContaining([
          "support@example.test|read|private-key",
          "support@example.test|read|rotated-private",
          "sales@example.test|read|private-key",
        ]),
      );
      expect(seen.find((s) => s.id === "held")!.version).not.toBe(seen.find((s) => s.key.includes("rotated"))!.version);
    } finally {
      release.resolve();
      await held?.catch(() => undefined);
      await client.close();
    }
  });
  it("refuses replacement credentials for a different account or different grants", async () => {
    await clear();
    const invoked = vi.fn<DriverFn<{ id: string }, { account: string }>>(async () => ({ account: "should-not-run" }));
    const client = await SanomaClient.connect({ ...config(), connectors: [mailWith(invoked)] });
    try {
      await bind(client);
      for (const key of ["sales@example.test|read|private", "support@example.test|write|private"]) {
        await client.setSecret("SUPPORT", encodeCredentials(auth, key), { by: "alice" });
        await expect(
          client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: support }),
        ).rejects.toThrow("Secret store: denied");
      }
      expect(invoked).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("reads no credential before policy allows the call, and reads only the selected bundle afterwards", async () => {
    await clear();
    const cfg = config();
    const read = vi.spyOn(cfg.secrets.store, "read");
    const root = tree(`connection-reads-${randomUUID()}`, {
      "policies/accounts.cedar": `forbid(principal, action == Sanoma::Action::"mail.message.read", resource) when { context has connection && context.connection.account == "sales@example.test" };`,
    });
    const client = await SanomaClient.connect({ ...cfg, root });
    try {
      await bind(client);
      await bind(client, sales, "sales@example.test");
      read.mockClear();
      await expect(
        client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: sales }),
      ).rejects.toMatchObject({ code: "policy_denied" });
      expect(read).not.toHaveBeenCalled();
      await client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: support });
      expect(read.mock.calls.map(([address]) => address.path)).toEqual(["SUPPORT"]);
    } finally {
      await client.close();
    }
  });
  it("rejects unmigrated drivers without reading credentials or using their environment", async () => {
    await clear();
    const cfg = config();
    const read = vi.spyOn(cfg.secrets.store, "read");
    const invoked = vi.fn<DriverFn<{ id: string }, { account: string }>>(async () => ({ account: "wrong" }));
    const unsupported = withSetup(mail, { driver: () => defineDriver(ops, { message: { read: invoked } }) });
    const client = await SanomaClient.connect({ ...cfg, connectors: [unsupported] });
    try {
      await bind(client);
      read.mockClear();
      await expect(
        client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: support }),
      ).rejects.toThrow("does not support");
      expect(read).not.toHaveBeenCalled();
      expect(invoked).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("withholds other accounts' secrets and removes credentials from driver exceptions", async () => {
    await clear();
    const cfg = config();
    const read = vi.spyOn(cfg.secrets.store, "read");
    const connector = mailWith(async (input, call) => {
      if (input.id === "another") await call.secrets.get("SALES");
      throw new Error(`SDK request: ${authenticationCredentials("key", auth, call)}`);
    });
    const client = await SanomaClient.connect({ ...cfg, connectors: [connector] });
    try {
      await bind(client);
      read.mockClear();
      for (const id of ["another", "exception"]) {
        const error = await client
          .call("mail.message.read", { id }, { actor: "alice", connection: support })
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ message: "mail operation failed" });
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("private-key");
      }
      expect(read.mock.calls.map(([address]) => address.path)).toEqual(["SUPPORT", "SUPPORT"]);
    } finally {
      await client.close();
    }
  });
  it("rejects duplicate names/defaults, wrong methods and wrong account/scope constraints", async () => {
    expect(() => connectionCatalog([mail], [support, support])).toThrow("duplicate");
    expect(() =>
      connectionCatalog(
        [mail],
        [
          { ...support, default: true },
          { ...sales, default: true },
        ],
      ),
    ).toThrow("only one");
    expect(() => defineConnection(mail, { name: "x", method: "unknown", credentials: secret("TOKEN") })).toThrow(
      "authentication method",
    );
    const strict = defineConnection(mail, {
      name: "strict",
      method: "key",
      credentials: secret("TOKEN"),
      scopes: ["read"],
      account: "expected",
    });
    const r = new ConnectionRegistry(connectionCatalog([mail], [strict]), () => pool.db());
    await expect(r.bind(strict, "other", ["read"], null, "alice")).rejects.toThrow("account");
    await expect(r.bind(strict, "expected", [], null, "alice")).rejects.toThrow("scopes");
  });
  it("two accounts share one connector while selection is explicit and typed", async () => {
    await clear();
    const client = await SanomaClient.connect(config());
    try {
      await bind(client);
      await bind(client, sales, "sales@example.test");
      await expect(client.call("mail.message.read", { id: "one" }, { actor: "alice" })).rejects.toThrow(
        "Select a named",
      );
      expect(
        await Promise.all(
          [support, sales].map((connection) =>
            client.call("mail.message.read", { id: "one" }, { actor: "alice", connection }),
          ),
        ),
      ).toEqual([{ account: "support@example.test" }, { account: "sales@example.test" }]);
      await expect(
        client.call(
          "mail.message.read",
          { id: "one" },
          { actor: "alice", connection: { $connection: support.$connection, vendor: "other" } },
        ),
      ).rejects.toThrow("another connector");
    } finally {
      await client.close();
    }
  });
  it("dynamic records require declared creation rules and remain scoped to their owner", async () => {
    await clear();
    const r = registry();
    await expect(r.create("mail/customer", "x", ["read"], "mallory")).rejects.toMatchObject({ code: "policy_denied" });
    const a = await r.create("mail/customer", "alice-account", ["read"], "alice");
    const ref = { $connection: a.id, vendor: "mail" };
    expect((await r.select("mail", ref, "alice"))?.account).toBe("alice-account");
    await expect(r.select("mail", ref, "bob")).rejects.toMatchObject({ code: "policy_denied" });
    const changed = new ConnectionRegistry(connectionCatalog([mail], [], []), () => pool.db());
    await expect(changed.select("mail", ref, "alice")).rejects.toThrow("not declared");
  });
  it("invalidates dynamic authority when the secret namespace or binding changes", async () => {
    await clear();
    const catalog = connectionCatalog([mail], [], [customer]);
    const store = memorySecretStore();
    const first = new ConnectionRegistry(catalog, () => pool.db(), new SecretAccess({ namespace: "first" }, store));
    const account = await first.create("mail/customer", "account", ["read"], "alice");
    const changed = new ConnectionRegistry(catalog, () => pool.db(), new SecretAccess({ namespace: "second" }, store));
    await expect(changed.assertCurrent(account, "alice")).rejects.toThrow("declaration changed");
    const rebound = new ConnectionRegistry(
      catalog,
      () => pool.db(),
      new SecretAccess(
        {
          namespace: "first",
          bindings: { [account.credentials!.$secret]: { path: "another-account", management: "sanoma" } },
        },
        store,
      ),
    );
    await expect(rebound.assertCurrent(account, "alice")).rejects.toThrow("declaration changed");
  });
  it("commits one dynamic account for concurrent direct requests with the same call id", async () => {
    await clear();
    const client = await SanomaClient.connect({ ...config(), ledger: undefined });
    try {
      const id = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          client.call(
            "sanoma.connection.create",
            { rule: "mail/customer", account: "account", scopes: ["read"] },
            { actor: "alice", id },
          ),
        ),
      );
      for (const result of results) expect(result).toEqual(results[0]);
      expect((await (await pool.db()).query("SELECT id FROM sanoma_connections")).rowCount).toBe(1);
      expect(
        (await (await pool.db()).query("SELECT id FROM sanoma_ledger WHERE run_id=$1", [`direct:alice:${id}`]))
          .rowCount,
      ).toBe(1);
    } finally {
      await client.close();
    }
  });
  it("allows code-authorized visitor signups without a declaration per customer", async () => {
    await clear();
    const rule = defineConnectionRule(mail, { name: "customers", method: "key", createBy: [{ group: "visitors" }] });
    const root = tree(`connection-signup-${randomUUID()}`, {
      "policies/signup.cedar": `permit(principal in Sanoma::Group::"visitors", action in [Sanoma::Action::"sanoma.connection.create", Sanoma::Action::"sanoma.connection.disconnect", Sanoma::Action::"mail.message.read"], resource);`,
    });
    const client = await SanomaClient.connect({ ...config(), root, connectionRules: [rule] });
    try {
      const actor = visitorPrincipal("github", "customer-1");
      const created = (await client.call(
        "sanoma.connection.create",
        { rule: "mail/customers", account: "customer-account", scopes: [] },
        { actor },
      )) as ConnectionSnapshot;
      const ref = { $connection: created.id, vendor: "mail" };
      await client.setSecret(created.credentials!.$secret, encodeCredentials(auth, "customer-account||private-key"), {
        by: "alice",
      });
      expect(await client.call("mail.message.read", { id: "one" }, { actor, connection: ref })).toEqual({
        account: "customer-account",
      });
      await expect(
        client.call(
          "mail.message.read",
          { id: "one" },
          { actor: visitorPrincipal("github", "customer-2"), connection: ref },
        ),
      ).rejects.toMatchObject({ code: "policy_denied" });
      await client.call(
        "sanoma.connection.disconnect",
        { connection: ref, expectedRevision: created.revision },
        { actor },
      );
      await expect(client.call("mail.message.read", { id: "one" }, { actor, connection: ref })).rejects.toThrow(
        "disconnected",
      );
      await expect(
        client.call(
          "sanoma.connection.create",
          { rule: "mail/customers", account: "anon", scopes: [] },
          { actor: { id: "anonymous" } },
        ),
      ).rejects.toMatchObject({ code: "policy_denied" });
    } finally {
      await client.close();
    }
  });
  it("an explicit default never changes a previously pinned account", async () => {
    await clear();
    const first = { ...support, default: true };
    const r = new ConnectionRegistry(connectionCatalog([mail], [first, sales]), () => pool.db());
    await r.bind(first, "first", ["read"], null, "alice");
    const pinned = await r.select("mail", undefined, "alice");
    expect(pinned?.id).toBe(first.$connection);
    const changed = new ConnectionRegistry(connectionCatalog([mail], [support, { ...sales, default: true }]), () =>
      pool.db(),
    );
    await changed.bind(sales, "second", ["read"], null, "alice");
    expect((await changed.select("mail", undefined, "alice"))?.id).toBe(sales.$connection);
    await expect(changed.assertCurrent(pinned, "alice")).rejects.toThrow("declaration changed");
  });
  it("pins a binding revision and refuses use after rebinding or changed requirements", async () => {
    await clear();
    const r = registry();
    const first = await r.bind(support, "one", ["read"], null, "alice");
    await expect(
      r.assertCurrent({ ...first, account: "two", credentials: { $secret: "SALES" } }, "alice"),
    ).rejects.toThrow("changed after authorization");
    await r.bind(support, "two", ["read"], first.revision, "alice");
    await expect(r.assertCurrent(first, "alice")).rejects.toThrow("changed after authorization");
    await expect(r.bind(support, "three", ["read"], first.revision, "alice")).rejects.toThrow("reload");
    const changed = new ConnectionRegistry(connectionCatalog([mail], [{ ...support, scopes: ["write"] }]), () =>
      pool.db(),
    );
    await expect(changed.select("mail", support, "alice")).rejects.toThrow("declaration changed");
  });
  it("Cedar sees the account alongside the existing business-resource target", async () => {
    await clear();
    const root = tree(`connection-policy-${randomUUID()}`, {
      "policies/accounts.cedar": `forbid(principal, action == Sanoma::Action::"mail.message.read", resource) when { context has connection && context.connection.account == "sales@example.test" && resource == Sanoma::Target::"message/one" };`,
    });
    const client = await SanomaClient.connect({ ...config(), root });
    try {
      await bind(client);
      await bind(client, sales, "sales@example.test");
      await expect(
        client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: sales }),
      ).rejects.toMatchObject({ code: "policy_denied" });
      expect(await client.call("mail.message.read", { id: "one" }, { actor: "alice", connection: support })).toEqual({
        account: "support@example.test",
      });
    } finally {
      await client.close();
    }
  });
  it("workflow calls pin metadata in history and the ledger without credential material", async () => {
    await clear();
    const cfg = config();
    const client = await SanomaClient.connect(cfg);
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await bind(client);
      worker = await startWorker(cfg);
      const run = await client.start(probe, {}, { startedBy: "alice" });
      expect(await client.result(run, 10_000)).toEqual({ account: "support@example.test" });
      expect((await client.ledger(run)).find((r) => r.type === "op.called")).toMatchObject({
        connection: { id: "mail/support", account: "support@example.test" },
      });
      const checkpoints = await (
        await pool.db()
      ).query("SELECT to_jsonb(o) AS record FROM dbos.operation_outputs o WHERE workflow_uuid=$1", [run]);
      expect(checkpoints.rowCount).toBeGreaterThan(0);
      expect(JSON.stringify(checkpoints.rows)).not.toContain("private-key");
      expect(JSON.stringify(await client.ledger(run))).not.toContain("private-key");
    } finally {
      await worker?.stop();
      await client.close();
    }
  });
  it("rebinding during a policy hold never authorizes the replacement account", async () => {
    await clear();
    const root = tree(`connection-hold-${randomUUID()}`, {
      "resources/people.ts": `import { sanoma } from "sanoma/resources"; export const alice = sanoma.person({ id: "alice" }); export const bob = sanoma.person({ id: "bob" });`,
      "policies/accounts.cedar": `@hold("bob") forbid(principal, action == Sanoma::Action::"mail.message.read", resource);`,
    });
    const cfg = { ...config(), root };
    const client = await SanomaClient.connect(cfg);
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      const first = await bind(client);
      worker = await startWorker(cfg);
      const run = await client.start(probe, {}, { startedBy: "alice" });
      const approvals = await waitFor(
        () => client.approvals(run),
        (a) => a.some((x) => x.status === "pending"),
        10_000,
      );
      await bind(client, support, "replacement@example.test", first.revision);
      await client.decide(run, {
        id: approvals.find((a) => a.status === "pending")!.id,
        by: { id: "bob" },
        decision: "approve",
      });
      await expect(client.result(run, 10_000)).rejects.toThrow("changed after authorization");
    } finally {
      await worker?.stop();
      await client.close();
    }
  });
});

describe("resource account selection", () => {
  it("applies identical resource identities to separate accounts and pins each lockfile binding", async () => {
    const box = defineResource({
      vendor: "accounts",
      type: "box",
      title: "Box",
      identity: "name",
      writable: true,
      schema: z.object({ name: z.string(), id: z.string().optional() }),
      fields: { immutable: [], vendorOwned: ["id"], writeOnly: [] },
      find: ({ name }) => name,
    });
    const operations = defineConnector("accounts", { box }, { package: "@test/accounts" });
    const created: string[] = [];
    const driver = defineDriver(
      operations,
      {
        box: {
          import: async (input, call) => ({
            id: input.id,
            gone: !created.includes(call.connection!.account),
            ...(created.includes(call.connection!.account) && { state: { name: "same", id: "object" } }),
          }),
          read: async (input) => ({ id: input.id, gone: true }),
          plan: async () => ({ action: "create" as const, planned: { name: "same" }, unknown: [], replace: [] }),
          create: async (input, call) => {
            created.push(call.connection!.account);
            return { id: "object", state: { name: String(input.desired.name), id: "object" } };
          },
          update: async (input) => ({ id: input.id, state: { name: String(input.desired.name) } }),
          delete: async (input) => ({ id: input.id, gone: true as const }),
        },
      },
      { authentication: ["key"] },
    );
    const connector = withSetup(operations, { authentication: { key: auth }, driver: () => driver });
    const a = defineConnection(connector, { name: "one", method: "key", credentials: secret("FIRST") });
    const b = defineConnection(connector, { name: "two", method: "key", credentials: secret("SECOND") });
    const root = tree(`resource-accounts-${randomUUID()}`, {
      "resources/boxes.ts": `import { accounts } from "@test/accounts/resources";
      export const first = accounts.box({ name: "same" }, { connection: { vendor: "accounts", $connection: "accounts/one" } });
      export const second = accounts.box({ name: "same" }, { connection: { vendor: "accounts", $connection: "accounts/two" } });`,
    });
    const cfg = {
      databaseUrl: testDatabaseUrl("resource_connections"),
      root,
      connectors: [connector],
      connections: [a, b],
      secrets: { store: memorySecretStore() },
      ledger: memoryLedger(),
    };
    const resourcePool = lazyPool(cfg.databaseUrl, "resource-connections-test");
    await (await resourcePool.db()).query("DELETE FROM sanoma_connections");
    await resourcePool.close();
    const client = await SanomaClient.connect(cfg);
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await client.setSecret("FIRST", encodeCredentials(auth, "one||private-key"), { by: "alice" });
      await client.setSecret("SECOND", encodeCredentials(auth, "two||private-key"), { by: "alice" });
      const first = (await client.call(
        "sanoma.connection.bind",
        { connection: a, account: "one", scopes: [], expectedRevision: null },
        { actor: "alice" },
      )) as ConnectionSnapshot;
      await client.call(
        "sanoma.connection.bind",
        { connection: b, account: "two", scopes: [], expectedRevision: null },
        { actor: "alice" },
      );
      worker = await startWorker(cfg);
      const run = await client.apply({}, { startedBy: "alice" });
      const report = (await client.result(run, 10_000)) as { results: { status: string }[] };
      expect(report.results.map((r) => r.status)).toEqual(["done", "done"]);
      expect(created).toEqual(["one", "two"]);
      const locks = JSON.parse(readFileSync(join(root, "resources/sanoma.lock.json"), "utf8"));
      expect(locks["resources/boxes.ts#first"].connection).toMatchObject({
        $connection: a.$connection,
        revision: first.revision,
      });
      await client.call(
        "sanoma.connection.bind",
        { connection: a, account: "replacement", scopes: [], expectedRevision: first.revision },
        { actor: "alice" },
      );
      const drift = await client.drift({ startedBy: "alice" });
      const after = await client.driftReport(drift);
      expect(after.problems.some((p) => p.message.includes("connection is unavailable or changed"))).toBe(true);
      expect(
        (await client.ledger(run))
          .filter((r) => r.type === "op.called" && r.op === "accounts.box.create")
          .map((r) => (r.type === "op.called" ? r.connection?.account : undefined)),
      ).toEqual(["one", "two"]);
    } finally {
      await worker?.stop();
      await client.close();
    }
  });
});
