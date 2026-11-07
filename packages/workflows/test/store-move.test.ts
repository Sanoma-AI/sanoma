import { randomBytes, randomUUID } from "node:crypto";
import crc32c from "crc-32/crc32c.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionCatalog, ConnectionRegistry } from "../src/connection.ts";
import {
  defineAuthentication,
  defineConnection,
  defineConnector,
  type SecretConfiguration,
  SecretStoreError,
  withSetup,
} from "../src/index.ts";
import { configuredSecrets, postgresSecretStore } from "../src/credentials.ts";
import { lazyDb, prepareDatabase } from "../src/db.ts";
import { connectionRenewals, secretMoveItems, secretMoves } from "../src/db/company.ts";
import { type GcpKmsClient, KMS_SECRETS_SQL, kmsPostgresStore } from "../src/kms-secrets.ts";
import { readStoreMoves, storeMoveDriver } from "../src/store-move.ts";
import { SanomaClient, startWorker } from "../src/index.ts";
import { freshDatabase, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. A move of the secrets between the built-in store and the
// KMS-protected Postgres store (with a fake KMS), both ways, through the move's driver: what it
// plans, copies, checks and retires, its receipts and its fence, and no value in what it answers.

const SENTINEL = `plaintext-sentinel-${randomUUID()}`;
const databaseUrl = freshDatabase("store_move");
const pool = lazyDb(databaseUrl, "store-move-tests");
const db = () => pool.db();

const sum = (b: Buffer) => crc32c.buf(b) >>> 0;
const bytes = (value: Uint8Array | string | null | undefined) =>
  typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value ?? []);
/** Wrapped data keys in memory, with the checksums the KMS store checks; payload AES and Postgres stay real. */
function fakeKms() {
  const keys = new Map<string, Buffer>();
  const state = { denied: false };
  const client: GcpKmsClient = {
    async encrypt(input) {
      if (state.denied) throw Object.assign(new Error("synthetic provider detail"), { code: 7 });
      const wrapped = randomBytes(32);
      keys.set(wrapped.toString("base64"), bytes(input.plaintext));
      return [
        {
          name: `${input.name}/cryptoKeyVersions/1`,
          ciphertext: wrapped,
          ciphertextCrc32c: { value: sum(wrapped) },
          verifiedPlaintextCrc32c: true,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        },
      ];
    },
    async decrypt(input) {
      if (state.denied) throw Object.assign(new Error("synthetic provider detail"), { code: 7 });
      const kept = keys.get(bytes(input.ciphertext).toString("base64"));
      if (!kept) throw Object.assign(new Error("synthetic provider detail"), { code: 3 });
      // A copy: the store zeroes the data key it is given once it has used it.
      const plain = Buffer.from(kept);
      return [{ plaintext: plain, plaintextCrc32c: { value: sum(plain) } }];
    },
  };
  return { client, state };
}
const KEY = "projects/test/locations/us/keyRings/r/cryptoKeys/acme";
const kms = fakeKms();
const kmsStore = kmsPostgresStore({ company: "acme", keyName: KEY, kms: kms.client });

const fieldsAuth = defineAuthentication({
  kind: "fields",
  version: 1,
  schema: z.object({ key: z.string() }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 4096 },
  verify: async () => ({ account: "ops@acme.test", scopes: ["read"] }),
});
const oauth = defineAuthentication({
  kind: "oauth2",
  version: 1,
  storage: { writable: true, conditionalWrites: true, maxBytes: 4096 },
  oauth: {
    authorizeUrl: "https://acme.test/authorize",
    tokenUrl: "https://acme.test/token",
    scopes: ["read"],
    pkce: true,
    clientAuthentication: "client_secret_basic",
  },
});
const ops = defineConnector("acme", {
  thing: { read: { effect: "read", input: z.object({}), output: z.object({}) } },
});
const acme = withSetup(ops, { authentication: { fieldsAuth, oauth } });
const keyed = defineConnection(acme, { name: "keyed", method: "fieldsAuth", credentials: { $secret: "ACME_KEY" } });
const granted = defineConnection(acme, {
  name: "granted",
  method: "oauth",
  credentials: { $secret: "ACME_GRANT" },
  client: { $secret: "ACME_CLIENT" },
});

const bindings = {
  PLAIN: { path: "plain/value", management: "sanoma" },
  OWNED_ELSEWHERE: { path: "theirs/value", management: "external" },
  FROM_ENV: { env: "STORE_MOVE_TEST_ENV" },
} satisfies SecretConfiguration["bindings"];
const builtinFirst: SecretConfiguration = {
  namespace: "live",
  bindings,
  stores: { kms: { store: kmsStore, namespace: "live" } },
};
const kmsFirst: SecretConfiguration = {
  store: kmsStore,
  namespace: "live",
  bindings,
  stores: { builtin: { namespace: "live" } },
};

/** The move's driver, its store access and connections, as a runtime with `secrets` makes them. */
function runtime(secrets: SecretConfiguration) {
  const access = configuredSecrets(secrets, db);
  const registry = new ConnectionRegistry(connectionCatalog([acme], [keyed, granted]), db, access);
  const driver = storeMoveDriver({
    config: secrets,
    secrets: access,
    registry,
    db,
    declared: async () => ({ names: [], problems: [] }),
  });
  const call = (op: string, input: unknown) =>
    driver.ops[`storeMigration.${op}`]!(input, {
      idempotencyKey: `${op}:${randomUUID()}`,
      runId: "test",
      opId: `sanoma.storeMigration.${op}`,
      attempt: 1,
      secrets: { get: async () => undefined, ensure: async () => "", delete: async () => {} },
      principal: { id: "alice" },
    }) as Promise<any>;
  return { access, registry, call };
}
const builtin = postgresSecretStore(db);
const raw = kmsPostgresStore({ company: "acme", keyName: KEY, kms: kms.client, database: db });
const answers: unknown[] = [];
const record = <T>(answer: T): T => (answers.push(answer), answer);

beforeAll(async () => {
  await prepareDatabase(databaseUrl);
  await (await db()).execute(sql.raw(KMS_SECRETS_SQL));
});
afterAll(() => pool.close());

describe("moving secrets between stores", () => {
  it("moves builtin → KMS and back, keeping names, connections and one writer, and never answering a value", async () => {
    const live = { namespace: "live" };
    const a = runtime(builtinFirst);
    await a.access.write("ACME_KEY", JSON.stringify({ version: 1, value: { key: `key-${SENTINEL}` } }), {
      expectedVersion: null,
      by: "alice",
    });
    await a.access.write("ACME_GRANT", `grant-${SENTINEL}`, { expectedVersion: null, by: "alice" });
    await a.access.write("ACME_CLIENT", `client-${SENTINEL}`, { expectedVersion: null, by: "alice" });
    await a.access.write("PLAIN", `plain-${SENTINEL}`, { expectedVersion: null, by: "alice" });
    await builtin.write({ ...live, path: "theirs/value" }, `external-${SENTINEL}`, {
      expectedVersion: null,
      by: "owner",
    });
    // The destination has an OAuth application of its own: the grant issued to ours needs consent again there.
    await raw.write({ ...live, path: "ACME_CLIENT" }, `their-client-${SENTINEL}`, {
      expectedVersion: null,
      by: "owner",
    });
    await a.registry.bind({ vendor: "acme", $connection: "acme/keyed" }, "ops@acme.test", ["read"], null, "alice");
    await a.registry.bind({ vendor: "acme", $connection: "acme/granted" }, "ops@acme.test", ["read"], null, "alice");

    const plan = record(await a.call("plan", { to: "kms" }));
    expect(plan.source).toEqual({ store: "postgres", namespace: "live" });
    expect(plan.destination).toEqual({ name: "kms", store: "kms-postgres", namespace: "live" });
    expect(plan.problems).toEqual([]);
    const byName = Object.fromEntries(plan.items.map((i: { name: string }) => [i.name, i]));
    expect(byName.ACME_KEY).toMatchObject({ kind: "fields", action: "copy", connections: ["acme/keyed"] });
    expect(byName.ACME_GRANT).toMatchObject({ kind: "oauth2", action: "copy", reauthorize: "client_changed" });
    expect(byName.ACME_CLIENT).toMatchObject({ kind: "oauth-client", action: "kept" });
    expect(byName.PLAIN).toMatchObject({
      action: "copy",
      sourcePath: "plain/value",
      bytes: `plain-${SENTINEL}`.length,
    });
    expect(byName.OWNED_ELSEWHERE).toMatchObject({ action: "external", management: "external" });
    expect(byName.FROM_ENV).toMatchObject({ action: "bound" });

    const move = `migrate-store:${randomUUID()}`;
    const prepared = record(await a.call("prepare", { move, to: "kms", retainHours: 0 }));
    expect(prepared).toMatchObject({ copy: 3, reauthorize: ["acme/granted"] });
    expect(prepared.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    // A second prepare (a retried step) finds the move as it was, and checks the store again from nothing.
    expect(await a.call("prepare", { move, to: "kms", retainHours: 0 })).toMatchObject({ copy: 3 });
    await expect(a.call("prepare", { move: "another", to: "kms", retainHours: 0 })).rejects.toThrow(/under way/);

    const copied = record(await a.call("transfer", { move }));
    expect(copied.copied.toSorted()).toEqual(["ACME_GRANT", "ACME_KEY", "PLAIN"]);
    // Quiesced: the source refuses writers from here on, through any runtime's access.
    await expect(a.access.write("PLAIN", "late", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(configuredSecrets(builtinFirst, db).delete("PLAIN")).rejects.toMatchObject({ code: "read_only" });
    expect(await a.access.get("PLAIN")).toBe(`plain-${SENTINEL}`);
    // Resumed: nothing copied twice.
    expect(record(await a.call("transfer", { move }))).toMatchObject({ copied: [], unchanged: 3 });

    expect(record(await a.call("verify", { move }))).toEqual({ next: "wait", stale: [], selected: "source" });
    // A write that slipped past the fence (one in flight when it went up): the read-back sees it, and copies again.
    const plain = await builtin.read({ ...live, path: "plain/value" });
    await builtin.write({ ...live, path: "plain/value" }, `plain-2-${SENTINEL}`, {
      expectedVersion: plain!.version,
      by: "racer",
    });
    expect(record(await a.call("verify", { move }))).toEqual({
      next: "transfer",
      stale: ["PLAIN"],
      selected: "source",
    });
    expect(record(await a.call("transfer", { move }))).toMatchObject({ copied: ["PLAIN"] });
    expect(record(await a.call("verify", { move }))).toMatchObject({ next: "wait" });
    await expect(a.call("cutover", { move })).rejects.toThrow(/still selects the source/);

    // The reviewed change deploys: the code selects the KMS store, and names the built-in one among `stores`.
    const b = runtime(kmsFirst);
    expect((await b.registry.cards("alice")).map((c) => c.status)).toEqual([
      "configuration_changed",
      "configuration_changed",
    ]);
    expect(record(await b.call("verify", { move }))).toEqual({ next: "cutover", stale: [], selected: "destination" });
    const cut = record(await b.call("cutover", { move }));
    expect(cut.rebound.toSorted()).toEqual(["acme/granted", "acme/keyed"]);
    expect(cut.reauthorize).toEqual(["acme/granted"]);
    expect((await b.registry.cards("alice")).map((c) => c.status)).toEqual(["connected", "connected"]);
    expect(await b.access.get("PLAIN")).toBe(`plain-2-${SENTINEL}`);
    expect(await b.access.get("ACME_CLIENT")).toBe(`their-client-${SENTINEL}`);
    // One writer: the destination takes writes now, and the old store still refuses an old runtime's.
    await b.access.write("PLAIN", `plain-3-${SENTINEL}`, {
      expectedVersion: (await b.access.read("PLAIN"))!.version,
      by: "alice",
    });
    await expect(a.access.write("NEW", "x", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
      code: "read_only",
    });

    const retired = record(await b.call("retire", { move }));
    expect(retired.retired.toSorted()).toEqual(["ACME_CLIENT", "ACME_GRANT", "ACME_KEY", "PLAIN"]);
    expect(retired.retained).toEqual([{ name: "OWNED_ELSEWHERE", why: "external" }]);
    expect(retired).toMatchObject({ deletion: "destroy", vendorRevocation: "not_performed" });
    expect(await builtin.read({ ...live, path: "plain/value" })).toBeUndefined();
    expect(await builtin.read({ ...live, path: "theirs/value" })).toBeDefined();
    expect((await readStoreMoves(await db()))[0]).toMatchObject({ id: move, phase: "retired", fenced: true });

    // And back again: the built-in store takes writes once a move cuts back over to it.
    const back = `migrate-store:${randomUUID()}`;
    expect(record(await b.call("plan", { to: "builtin" })).problems).toEqual([]);
    await b.call("prepare", { move: back, to: "builtin", retainHours: 0 });
    expect(record(await b.call("transfer", { move: back })).copied.toSorted()).toEqual([
      "ACME_CLIENT",
      "ACME_GRANT",
      "ACME_KEY",
      "PLAIN",
    ]);
    expect(record(await b.call("verify", { move: back }))).toMatchObject({ next: "wait" });
    const c = runtime(builtinFirst);
    expect(record(await c.call("verify", { move: back }))).toMatchObject({ next: "cutover" });
    record(await c.call("cutover", { move: back }));
    expect(await c.access.get("PLAIN")).toBe(`plain-3-${SENTINEL}`);
    await c.access.write("NEW", "writable again", { expectedVersion: null, by: "alice" });
    expect((await c.registry.cards("alice")).map((card) => card.status)).toEqual(["connected", "connected"]);
    record(await c.call("retire", { move: back }));

    // Nothing the move answered, nor its rows, holds a value.
    const rows = JSON.stringify([
      await (await db()).select().from(secretMoves),
      await (await db()).select().from(secretMoveItems),
    ]);
    expect(JSON.stringify(answers)).not.toContain(SENTINEL);
    expect(rows).not.toContain(SENTINEL);
  });

  it("never replaces a destination value it did not write, and refuses a destination it cannot use", async () => {
    const namespace = `refuse-${randomUUID()}`;
    const config: SecretConfiguration = {
      namespace,
      bindings: { PLAIN: { path: "plain", management: "sanoma" } },
      stores: { kms: { store: kmsStore, namespace } },
    };
    const a = runtime(config);
    await a.access.write("PLAIN", "ours", { expectedVersion: null, by: "alice" });
    await raw.write({ namespace, path: "plain" }, "theirs", { expectedVersion: null, by: "owner" });
    expect((await a.call("plan", { to: "kms" })).problems).toEqual(["PLAIN: the destination holds another value"]);
    await expect(a.call("prepare", { move: randomUUID(), to: "kms", retainHours: 0 })).rejects.toThrow(
      /the destination holds another value/,
    );
    expect(await raw.read({ namespace, path: "plain" })).toMatchObject({ value: "theirs" });
    // Access lost at the destination: planned as a problem, never a provider's words.
    kms.state.denied = true;
    try {
      const plan = await a.call("plan", { to: "kms" });
      expect(plan.problems).toContain("destination: denied");
      expect(JSON.stringify(plan)).not.toContain("synthetic provider detail");
    } finally {
      kms.state.denied = false;
    }
    await expect(a.call("plan", { to: "nowhere" })).rejects.toThrow(/no store is named nowhere/);
  });

  it("resumes an interrupted copy, and a cancel lifts the fence and leaves the copies inactive", async () => {
    const namespace = `resume-${randomUUID()}`;
    let writes = 0;
    const flaky = kmsPostgresStore({ company: "acme", keyName: KEY, kms: kms.client, database: db });
    const interrupted = {
      ...flaky,
      id: flaky.id,
      capabilities: flaky.capabilities,
      validate: (ns: string) => flaky.validate(ns),
      read: flaky.read.bind(flaky),
      delete: flaky.delete.bind(flaky),
      write: async (...args: Parameters<typeof flaky.write>) => {
        if (args[0].namespace === namespace && ++writes === 2) throw new SecretStoreError("unavailable");
        return flaky.write(...args);
      },
    };
    const config: SecretConfiguration = { namespace, stores: { kms: { store: interrupted, namespace } } };
    const a = runtime(config);
    for (const name of ["ONE", "TWO", "THREE"])
      await a.access.write(name, `${name}-value`, { expectedVersion: null, by: "alice" });
    const move = randomUUID();
    await a.call("prepare", {
      move,
      to: "kms",
      names: ["ONE", "TWO", "THREE"],
      retainHours: 0,
    });
    // An OAuth renewal that has sent its refresh token: the fence waits until its grant is stored.
    const lease = `acme/renewing-${randomUUID()}`;
    await (await db()).insert(connectionRenewals).values({
      connectionId: lease,
      holder: randomUUID(),
      leaseUntil: sql`now() + interval '1 minute'`,
      sentAt: sql`now()`,
    });
    await expect(a.call("transfer", { move })).rejects.toMatchObject({ retryable: true, message: /renewal/ });
    expect((await (await db()).select().from(secretMoves).where(eq(secretMoves.id, move)))[0]?.fenced).toBe(false);
    await (await db()).delete(connectionRenewals).where(eq(connectionRenewals.connectionId, lease));
    await expect(a.call("transfer", { move })).rejects.toMatchObject({ retryable: true });
    const [first] = (await (await db()).select().from(secretMoveItems).where(eq(secretMoveItems.moveId, move))).filter(
      (i) => i.state === "copied",
    );
    expect(first).toBeDefined();
    const again = await a.call("transfer", { move });
    expect(again.unchanged).toBe(1);
    expect(again.copied).toHaveLength(2);
    expect(await raw.read({ namespace, path: first!.destinationPath })).toMatchObject({
      version: first!.destinationVersion,
    });
    await expect(a.access.write("ONE", "x", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
      code: "read_only",
    });
    expect(await a.call("cancel", { move })).toEqual({
      phase: "cancelled",
      atDestination: ["ONE", "THREE", "TWO"],
    });
    await a.access.write("FOUR", "writable again", { expectedVersion: null, by: "alice" });
    expect(await a.call("verify", { move })).toMatchObject({ next: "cancelled" });
    const [row] = await (await db()).select().from(secretMoves).where(eq(secretMoves.id, move));
    expect(row).toMatchObject({ phase: "cancelled", fenced: false });
  });
});

describe("the migrate-store run", () => {
  it("runs a move in order, resumes on the switched code, and leaves no value in DBOS's tables or the ledger", async () => {
    const namespace = `run-${randomUUID()}`;
    const plain = { PLAIN: { path: "run/plain", management: "sanoma" } } as const;
    const before = {
      databaseUrl,
      connectors: [],
      secrets: { namespace, bindings: plain, stores: { kms: { store: kmsStore, namespace } } },
    };
    const after = {
      databaseUrl,
      connectors: [],
      secrets: { store: kmsStore, namespace, bindings: plain, stores: { builtin: { namespace } } },
    };
    // Each deploy a version of its own: the run is carried onto the next (`stampVersion`).
    vi.stubEnv("DBOS__APPVERSION", `before-${namespace}`);
    let worker = await startWorker(before);
    let client = await SanomaClient.connect(before);
    let runId: string;
    try {
      await client.setSecret("PLAIN", `run-${SENTINEL}`, { by: "alice" });
      runId = await client.start("migrate-store", { to: "kms", retainHours: 0 }, { startedBy: "alice" });
      await waitFor(async () => (await client.storeMoves({ actor: "alice" }))[0]?.phase === "verified", 30_000);
      expect((await client.storeMoves({ actor: "alice" }))[0]).toMatchObject({
        id: runId,
        destinationName: "kms",
        fenced: true,
        items: [{ name: "PLAIN", action: "copy", state: "verified", bytes: `run-${SENTINEL}`.length }],
      });
      await expect(client.setSecret("PLAIN", "late", { by: "alice" })).rejects.toThrow(/read.only/);
    } finally {
      await client.close();
      await worker.stop();
    }
    // The switch deploys: a worker on the code that selects the KMS store takes the run over.
    vi.stubEnv("DBOS__APPVERSION", `after-${namespace}`);
    worker = await startWorker(after);
    client = await SanomaClient.connect(after);
    try {
      expect(await client.result(runId, 60_000)).toEqual({ phase: "retired", retired: ["PLAIN"] });
      expect((await client.secrets(["PLAIN"])).get("PLAIN")?.value).toBe(`run-${SENTINEL}`);
      expect(await builtin.read({ namespace, path: "run/plain" })).toBeUndefined();
      const ledger = (await client.ledger(runId)).filter((r) => r.type === "op.called").map((r) => r.op);
      expect(ledger).toEqual([
        "sanoma.storeMigration.plan",
        "sanoma.storeMigration.prepare",
        "sanoma.storeMigration.transfer",
        "sanoma.storeMigration.verify",
        ...ledger.slice(4, -2),
        "sanoma.storeMigration.cutover",
        "sanoma.storeMigration.retire",
      ]);
    } finally {
      await client.close();
      await worker.stop();
    }
    // Every text column of DBOS's tables and the runtime's: the value is in none (the stores hold it sealed).
    const columns = await (
      await db()
    ).execute<{ s: string; t: string; c: string }>(sql`
      SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema IN ('dbos', 'public', 'sanoma_kms') AND data_type IN ('text', 'jsonb', 'json', 'character varying')`);
    const found: string[] = [];
    for (const { s, t, c } of columns.rows) {
      const hit = await (
        await db()
      ).execute(
        sql`SELECT 1 FROM ${sql.identifier(s)}.${sql.identifier(t)} WHERE ${sql.identifier(c)}::text LIKE ${`%${SENTINEL}%`} LIMIT 1`,
      );
      if (hit.rows.length) found.push(`${s}.${t}.${c}`);
    }
    expect(columns.rows.length).toBeGreaterThan(10);
    expect(found).toEqual([]);
  }, 120_000);
});
