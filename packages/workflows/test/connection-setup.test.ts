import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import {
  defineAuthentication,
  defineConnection,
  defineConnectionRule,
  defineConnector,
  defineDriver,
  encodeCredentials,
  AuthenticationError,
  memorySecretStore,
  SanomaClient,
  SecretStoreError,
  startWorker,
  withSetup,
  type AuthenticationContext,
} from "../src/index.ts";
import { secret } from "../src/secret.ts";
import { lazyPool } from "../src/db.ts";
import { tree } from "./tree.ts";

const verify = vi.fn<(credentials: { token: string }) => Promise<{ account: string; scopes: string[] }>>(
  async ({ token }) => ({ account: token.split("|")[0]!, scopes: ["read"] }),
);
const authentication = defineAuthentication({
  kind: "fields",
  version: 1,
  schema: z.object({ token: z.string().min(1) }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 512 },
  verify,
});
const ops = defineConnector("inbox", {
  message: { read: { effect: "read", input: z.object({}), output: z.object({ account: z.string() }) } },
});
const inbox = withSetup(ops, {
  authentication: { token: authentication },
  driver: () =>
    defineDriver(
      ops,
      { message: { read: async (_input, call) => ({ account: call.connection!.account }) } },
      { authentication: ["token"] },
    ),
});
const support = defineConnection(inbox, {
  name: "support",
  method: "token",
  credentials: secret("SUPPORT"),
  scopes: ["read"],
});
const sales = defineConnection(inbox, {
  name: "sales",
  method: "token",
  credentials: secret("SALES"),
  scopes: ["read"],
});
const rule = defineConnectionRule(inbox, {
  name: "customers",
  method: "token",
  createBy: ["alice", "bob"],
  scopes: ["read"],
});
const dbUrl = testDatabaseUrl("connection_setup");
const pool = lazyPool(dbUrl, "connection-setup-tests");
afterAll(() => pool.close());
beforeEach(async () => {
  await (
    await pool.db()
  ).query("TRUNCATE sanoma_connections, sanoma_connection_setups, sanoma_connection_health, sanoma_ledger");
  await (await pool.db()).query("TRUNCATE dbos.workflow_status CASCADE");
  verify.mockClear();
});
const config = () => ({
  databaseUrl: dbUrl,
  workflows: [],
  connectors: [inbox],
  connections: [support, sales],
  connectionRules: [rule],
  secrets: { store: memorySecretStore() },
});
const value = (account: string) => ({ token: `${account}|never-record-this-key` });
const target = { connection: support };
const people = `import { sanoma } from "sanoma/resources";
export const alice = sanoma.person({ id: "alice" });
export const bob = sanoma.person({ id: "bob" });`;

beforeAll(async () => {
  const client = await SanomaClient.connect(config());
  await client.close();
});

describe("secure connection setup", () => {
  it("passes server-selected workload identities through intake, activation and authorized calls without secret storage", async () => {
    const seen: AuthenticationContext[] = [];
    const workload = withSetup(ops, {
      authentication: {
        identity: defineAuthentication({
          kind: "workload-identity",
          async verify(context) {
            if (!context) throw new AuthenticationError("missing");
            seen.push(context);
            return { account: `verified:${context.connectionId}`, scopes: [] };
          },
        }),
      },
      driver: () =>
        defineDriver(
          ops,
          {
            message: { read: async (_input, call) => ({ account: call.connection!.account }) },
          },
          { authentication: ["identity"] },
        ),
    });
    const connections = ["production", "development"].map((name) =>
      defineConnection(workload, { name, method: "identity" }),
    );
    const store = memorySecretStore();
    const read = vi.spyOn(store, "read");
    const write = vi.spyOn(store, "write");
    const client = await SanomaClient.connect({
      ...config(),
      connectors: [workload],
      connections,
      connectionRules: [],
      secrets: { store },
    });
    try {
      for (const connection of connections) {
        const preview = await client.previewConnection({ connection }, undefined, { actor: "alice", id: randomUUID() });
        expect(preview.account).toBe(`verified:${connection.$connection}`);
        await client.connectConnection(preview, undefined, { actor: "alice" });
        expect(await client.call("inbox.message.read", {}, { actor: "alice", connection })).toEqual({
          account: `verified:${connection.$connection}`,
        });
        expect(seen.splice(0)).toEqual(
          Array.from({ length: 4 }, () => ({ vendor: "inbox", connectionId: connection.$connection })),
        );
      }
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses non-conditional managed writes before intake or pausing a connected account", async () => {
    const cfg = config();
    const original = await SanomaClient.connect(cfg);
    const review = await original.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
    await original.connectConnection(review, value("support"), { actor: "alice" });
    const replacement = await original.previewConnection(target, value("replacement"), {
      actor: "alice",
      id: randomUUID(),
    });
    await original.close();
    const read = vi.spyOn(cfg.secrets.store, "read");
    const write = vi.spyOn(cfg.secrets.store, "write");
    const client = await SanomaClient.connect({
      ...cfg,
      secrets: {
        store: { ...cfg.secrets.store, capabilities: { ...cfg.secrets.store.capabilities, conditionalWrites: "none" } },
      },
    });
    try {
      await expect(
        client.previewConnection(target, value("replacement"), { actor: "alice", id: randomUUID() }),
      ).rejects.toMatchObject({ code: "unsupported" });
      await expect(
        client.connectConnection(replacement, value("replacement"), { actor: "alice" }),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect((await client.connections({ actor: "alice" }))[0]).toMatchObject({
        status: "connected",
        account: "support",
      });
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("reviews the previous account and destination before rebinding storage, without moving the old value", async () => {
    const cfg = config();
    const original = await SanomaClient.connect(cfg);
    const review = await original.previewConnection(target, value("old-account"), { actor: "alice", id: randomUUID() });
    await original.connectConnection(review, value("old-account"), { actor: "alice" });
    await original.close();
    const moved = await SanomaClient.connect({ ...cfg, secrets: { ...cfg.secrets, namespace: "destination" } });
    try {
      const card = (await moved.connections({ actor: "alice" }))[0]!;
      expect(card).toMatchObject({
        status: "configuration_changed",
        location: { namespace: "destination" },
        boundLocation: { namespace: "default" },
      });
      const next = await moved.previewConnection(target, value("new-account"), { actor: "alice", id: randomUUID() });
      expect(next).toMatchObject({
        previousAccount: "old-account",
        account: "new-account",
        previousLocation: { namespace: "default", path: "SUPPORT" },
        location: { namespace: "destination" },
      });
      await moved.connectConnection(next, value("new-account"), { actor: "alice" });
      expect((await moved.connections({ actor: "alice" }))[0]?.boundLocation?.namespace).toBe("destination");
      expect((await cfg.secrets.store.read({ namespace: "default", path: "SUPPORT" }))?.value).toContain("old-account");
      expect((await cfg.secrets.store.read({ namespace: "destination", path: "SUPPORT" }))?.value).toContain(
        "new-account",
      );
    } finally {
      await moved.close();
    }
  });

  it("lets only one competing review reserve and write an account", async () => {
    const cfg = config();
    const write = vi.spyOn(cfg.secrets.store, "write");
    const client = await SanomaClient.connect(cfg);
    try {
      const first = await client.previewConnection(target, value("first"), { actor: "alice", id: randomUUID() });
      const second = await client.previewConnection(target, value("second"), { actor: "alice", id: randomUUID() });
      const results = await Promise.allSettled([
        client.connectConnection(first, value("first"), { actor: "alice" }),
        client.connectConnection(second, value("second"), { actor: "alice" }),
      ]);
      const saved = results.filter((result) => result.status === "fulfilled");
      expect(saved).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(await client.call("inbox.message.read", {}, { actor: "alice", connection: support })).toEqual({
        account: saved[0]!.value.account,
      });
    } finally {
      await client.close();
    }
  });

  it("does not return stale healthy status after a concurrent disconnect", async () => {
    const client = await SanomaClient.connect(config());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      const connected = await client.connectConnection(review, value("support"), { actor: "alice" });
      verify.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { account: "support", scopes: ["read"] };
      });
      const testing = client
        .call("sanoma.connection.test", { connection: support }, { actor: "alice" })
        .catch((error: unknown) => error);
      await entered.promise;
      await client.call(
        "sanoma.connection.disconnect",
        { connection: support, expectedRevision: connected.revision },
        { actor: "alice" },
      );
      release.resolve();
      await expect(testing).resolves.toMatchObject({ code: "invalid_input" });
      const card = (await client.connections({ actor: "alice" }))[0]!;
      expect(card.status).toBe("disconnected");
      expect(card.health).toBeUndefined();
    } finally {
      release.resolve();
      await client.close();
    }
  });

  it("reports safe verified health and external renewal without exposing the bundle", async () => {
    const cfg = config();
    const address = { namespace: "default", path: "SUPPORT" };
    const first = await cfg.secrets.store.write(address, encodeCredentials(authentication, value("support")), {
      expectedVersion: null,
      by: "owner",
    });
    const client = await SanomaClient.connect({
      ...cfg,
      secrets: { ...cfg.secrets, bindings: { SUPPORT: { path: "SUPPORT", management: "external" } } },
    });
    try {
      const test = () => client.call("sanoma.connection.test", { connection: support }, { actor: "alice" });
      expect(await test()).toMatchObject({ state: "missing" });
      const review = await client.previewConnection(target, undefined, { actor: "alice", id: randomUUID() });
      await client.connectConnection(review, undefined, { actor: "alice" });
      for (const problem of ["expired", "revoked", "uncertain"] as const) {
        verify.mockImplementationOnce(async () => {
          throw new AuthenticationError(problem);
        });
        expect(await test()).toMatchObject({ state: problem });
        expect((await client.connections({ actor: "alice" }))[0]?.health?.state).toBe(problem);
      }
      const replaced = await cfg.secrets.store.write(
        address,
        encodeCredentials(authentication, { token: "support|rotated-key" }),
        { expectedVersion: first.version, by: "owner" },
      );
      expect(await test()).toMatchObject({ state: "connected", externallyRenewed: true });
      expect(JSON.stringify(await client.connections({ actor: "alice" }))).not.toContain("rotated-key");
      await cfg.secrets.store.delete(address, { expectedVersion: replaced.version, by: "owner" });
      expect(await test()).toMatchObject({ state: "missing" });
    } finally {
      await client.close();
    }
  });

  it("refuses a denied Test action without reading a secret or invoking the provider", async () => {
    const cfg = config();
    const client = await SanomaClient.connect({
      ...cfg,
      root: tree(`test-denied-${randomUUID()}`, {
        "policies/setup.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.connection.test", resource);`,
      }),
    });
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      await client.connectConnection(review, value("support"), { actor: "alice" });
      const read = vi.spyOn(cfg.secrets.store, "read");
      verify.mockClear();
      await expect(
        client.call("sanoma.connection.test", { connection: support }, { actor: "alice" }),
      ).rejects.toMatchObject({ code: "policy_denied" });
      expect(read).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("rejects a stale store version before reserving or changing the connection", async () => {
    const cfg = config();
    const client = await SanomaClient.connect(cfg);
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      await cfg.secrets.store.write(
        { namespace: "default", path: "SUPPORT" },
        encodeCredentials(authentication, value("other")),
        { expectedVersion: null, by: "another-writer" },
      );
      await expect(client.connectConnection(review, value("support"), { actor: "alice" })).rejects.toMatchObject({
        code: "conflict",
      });
      expect((await client.connections({ actor: "alice" }))[0]?.status).toBe("missing");
    } finally {
      await client.close();
    }
  });

  it("rejects changed policy and destination before reading or writing credentials", async () => {
    const cfg = config();
    const client = await SanomaClient.connect(cfg);
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      const read = vi.spyOn(cfg.secrets.store, "read");
      for (const changed of [
        { ...cfg, secrets: { ...cfg.secrets, namespace: "another-deployment" } },
        {
          ...cfg,
          root: tree(`setup-policy-change-${randomUUID()}`, {
            "policies/setup.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.connection.prepare", resource);`,
          }),
        },
      ]) {
        const other = await SanomaClient.connect(changed);
        try {
          await expect(other.connectConnection(review, value("support"), { actor: "alice" })).rejects.toMatchObject({
            code: "invalid_input",
          });
        } finally {
          await other.close();
        }
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("connects from a read-only store without writing, even with the default logical binding", async () => {
    const cfg = config();
    await cfg.secrets.store.write(
      { namespace: "default", path: "SUPPORT" },
      encodeCredentials(authentication, value("support")),
      { expectedVersion: null, by: "owner" },
    );
    const write = vi.spyOn(cfg.secrets.store, "write");
    const readOnly = { ...cfg.secrets.store, capabilities: { ...cfg.secrets.store.capabilities, writable: false } };
    const client = await SanomaClient.connect({ ...cfg, secrets: { store: readOnly } });
    try {
      const review = await client.previewConnection(target, undefined, { actor: "alice", id: randomUUID() });
      await expect(client.connectConnection(review, undefined, { actor: "alice" })).resolves.toMatchObject({
        account: "support",
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses configure policy before any key write or metadata reservation", async () => {
    const cfg = config();
    const write = vi.spyOn(cfg.secrets.store, "write");
    const client = await SanomaClient.connect({
      ...cfg,
      root: tree(`configure-denied-${randomUUID()}`, {
        "policies/setup.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.connection.configure", resource);`,
      }),
    });
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      await expect(client.connectConnection(review, value("support"), { actor: "alice" })).rejects.toMatchObject({
        code: "policy_denied",
      });
      expect(write).not.toHaveBeenCalled();
      expect((await client.connections({ actor: "alice" }))[0]?.status).toBe("missing");
    } finally {
      await client.close();
    }
  });
  it("reviews and connects two accounts without putting credential input into metadata or history", async () => {
    const cfg = config();
    const client = await SanomaClient.connect(cfg);
    try {
      for (const [connection, account] of [
        [support, "support"],
        [sales, "sales"],
      ] as const) {
        const review = await client.previewConnection({ connection }, value(account), {
          actor: "alice",
          id: randomUUID(),
        });
        expect(review).toMatchObject({
          account,
          expectedRevision: null,
          location: { store: "memory", management: "sanoma" },
        });
        expect(JSON.stringify(review)).not.toContain("never-record");
        await client.connectConnection(review, value(account), { actor: "alice" });
        expect(await client.call("inbox.message.read", {}, { actor: "alice", connection })).toEqual({ account });
        // A retry returns the completed metadata operation; it does not overwrite another version.
        await expect(client.connectConnection(review, value(account), { actor: "alice" })).resolves.toMatchObject({
          account,
        });
      }
      expect(await client.connections({ actor: "alice" })).toMatchObject([
        { id: "inbox/support", account: "support", status: "connected", updatedBy: "alice" },
        { id: "inbox/sales", account: "sales", status: "connected", updatedBy: "alice" },
      ]);
      const records = await (await pool.db()).query("SELECT to_jsonb(t) FROM sanoma_ledger t");
      expect(records.rowCount).toBeGreaterThan(0);
      expect(JSON.stringify(records.rows)).not.toContain("never-record");
      const read = vi.spyOn(cfg.secrets.store, "read");
      await client.connections({ actor: "alice" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses a denied prepare before reading a store or verifying submitted credentials", async () => {
    const cfg = config();
    const read = vi.spyOn(cfg.secrets.store, "read");
    const root = tree(`setup-denied-${randomUUID()}`, {
      "policies/setup.cedar": `forbid(principal, action == Sanoma::Action::"sanoma.connection.prepare", resource);`,
    });
    const client = await SanomaClient.connect({ ...cfg, root });
    try {
      await expect(
        client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() }),
      ).rejects.toMatchObject({ code: "policy_denied" });
      expect(read).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("keeps external secrets in their owner's store and never offers a replacement through intake", async () => {
    const cfg = config();
    await cfg.secrets.store.write(
      { namespace: "default", path: "existing" },
      encodeCredentials(authentication, value("support")),
      { by: "owner", expectedVersion: null },
    );
    const writes = vi.spyOn(cfg.secrets.store, "write");
    const client = await SanomaClient.connect({
      ...cfg,
      secrets: { ...cfg.secrets, bindings: { SUPPORT: { path: "existing", management: "external" as const } } },
    });
    try {
      const review = await client.previewConnection(target, undefined, { actor: "alice", id: randomUUID() });
      expect(review.location).toMatchObject({ management: "external", path: "existing" });
      const connected = await client.connectConnection(review, undefined, { actor: "alice" });
      await expect(
        client.previewConnection(target, value("replacement"), { actor: "alice", id: randomUUID() }),
      ).rejects.toMatchObject({ code: "read_only" });
      await client.call(
        "sanoma.connection.disconnect",
        { connection: support, expectedRevision: connected.revision },
        { actor: "alice" },
      );
      expect(writes).not.toHaveBeenCalled();
      expect(await cfg.secrets.store.read({ namespace: "default", path: "existing" })).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("allocates dynamic accounts from declared rules and isolates their cards and credential locations by owner", async () => {
    const client = await SanomaClient.connect(config());
    try {
      const request = randomUUID();
      const a = await client.previewConnection({ rule: "inbox/customers" }, value("a"), {
        actor: "alice",
        id: request,
      });
      const b = await client.previewConnection({ rule: "inbox/customers" }, value("b"), { actor: "bob", id: request });
      expect(a.id).not.toBe(b.id);
      expect(a.credential).not.toBe(b.credential);
      await client.connectConnection(a, value("a"), { actor: "alice" });
      await client.connectConnection(b, value("b"), { actor: "bob" });
      expect((await client.connections({ actor: "alice" })).map((c) => c.id)).toContain(a.id);
      expect((await client.connections({ actor: "alice" })).map((c) => c.id)).not.toContain(b.id);
      await expect(
        client.previewConnection({ connection: { vendor: "inbox", $connection: a.id } }, value("a"), {
          actor: "bob",
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "policy_denied" });
    } finally {
      await client.close();
    }
  });

  it("leaves an uncertain write unusable instead of activating or retrying it", async () => {
    const cfg = config();
    const write = cfg.secrets.store.write.bind(cfg.secrets.store);
    vi.spyOn(cfg.secrets.store, "write").mockImplementation(async (...args) => {
      await write(...args);
      throw new SecretStoreError("unavailable");
    });
    const client = await SanomaClient.connect(cfg);
    try {
      const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
      await expect(client.connectConnection(review, value("support"), { actor: "alice" })).rejects.toMatchObject({
        code: "unavailable",
      });
      expect((await client.connections({ actor: "alice" }))[0]).toMatchObject({ status: "uncertain" });
      await expect(client.call("inbox.message.read", {}, { actor: "alice", connection: support })).rejects.toThrow(
        "missing or disconnected",
      );
    } finally {
      await client.close();
    }
  });

  it.each(["configure", "activate"] as const)(
    "resumes secure input after %s approval without repeating a stored write",
    async (action) => {
      const cfg = {
        ...config(),
        root: tree(`setup-approval-${randomUUID()}`, {
          "resources/people.ts": people,
          "policies/setup.cedar": `@hold("bob") forbid(principal, action == Sanoma::Action::"sanoma.connection.${action}", resource);`,
        }),
      };
      const write = vi.spyOn(cfg.secrets.store, "write");
      const client = await SanomaClient.connect(cfg);
      let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
      try {
        worker = await startWorker(cfg);
        const review = await client.previewConnection(target, value("support"), { actor: "alice", id: randomUUID() });
        const failure = (await client
          .connectConnection(review, value("support"), { actor: "alice" })
          .catch((e: unknown) => e)) as { code: string; data: { runId: string } };
        expect(failure.code).toBe("approval_pending");
        expect(write).toHaveBeenCalledTimes(action === "configure" ? 0 : 1);
        const approvals = await waitFor(
          () => client.approvals(failure.data.runId),
          (list) => list.some((a) => a.status === "pending"),
          10_000,
        );
        await client.decide(failure.data.runId, {
          id: approvals.find((a) => a.status === "pending")!.id,
          by: { id: "bob" },
          decision: "approve",
        });
        await client.result(failure.data.runId, 10_000);
        await expect(client.connectConnection(review, value("support"), { actor: "alice" })).resolves.toMatchObject({
          account: "support",
        });
        expect(write).toHaveBeenCalledTimes(1);
        const history = await (
          await pool.db()
        ).query("SELECT to_jsonb(o) FROM dbos.operation_outputs o WHERE workflow_uuid=$1", [failure.data.runId]);
        expect(history.rowCount).toBeGreaterThan(0);
        expect(JSON.stringify(history.rows)).not.toContain("never-record");
        expect(JSON.stringify(await client.ledger(failure.data.runId))).not.toContain("never-record");
      } finally {
        await worker?.stop();
        await client.close();
      }
    },
  );
});
