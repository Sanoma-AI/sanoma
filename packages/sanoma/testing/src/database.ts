import { randomBytes } from "node:crypto";
import {
  type CallContext,
  defineConnector,
  defineDriver,
  defineResource,
  type Driver,
  errorMessage,
  type PlanAction,
  type Resource,
  type SanomaClient,
  type SanomaConfig,
  startWorker,
  storeDatabaseUrl,
  withSetup,
  type Worker,
} from "@sanoma-ai/workflows";
import { Client, escapeIdentifier } from "pg";
import { z } from "zod";
import {
  credentialHeard,
  HOST_CHECK_CREDENTIAL,
  type HostCheck,
  hostCheck,
  hostCheckWorkflows,
  runEnded,
} from "./host.ts";
import { testDatabaseUrl } from "./index.ts";

// The conformance kit for the `Database` contract: whether a database holds the company as the
// runtime needs. `checkDatabase` applies a declared database, starts a worker on its URL, and
// drives it through a client on that URL, then reports each check. `fakeDatabase` is a database
// on the test Postgres, for the kit's own tests and for building against the contract before a
// real database lands: one that pauses, its suspend dropping every connection to it.

type State = Record<string, unknown>;

/**
 * The config the kit's worker runs on `databaseUrl`, and the client's: `hostCheck` and
 * `hostCheckWorkflows`, with no root, so the client's runs are of the worker's version.
 */
export const databaseCheckConfig = (databaseUrl: string): SanomaConfig => ({
  workflows: [...hostCheckWorkflows],
  connectors: [hostCheck],
  databaseUrl,
});

/** A declared database under test, and how to drive it. */
export interface DatabaseUnderTest {
  /** Its resource type, which meets the contract (`database`). */
  type: Pick<Resource, "vendor" | "type" | "database">;
  /** Makes the database match its declaration (created when it is not there); returns its state. */
  apply(): Promise<State>;
  /** The URL its `storeUrl` stores, which only the secrets store holds: read here for the test alone. */
  url(): Promise<string>;
  /**
   * Suspends its compute, as the vendor does after a while without queries, dropping every
   * connection: the next connection wakes it. Required when the type `pauses`.
   */
  suspend?(): Promise<unknown>;
  /** A client on `url()`, its config `databaseCheckConfig(url)`. */
  client: SanomaClient;
  /** How long a check waits. Default 60 s. */
  timeoutMs?: number;
}

/** One check's outcome. */
export type DatabaseCheck = HostCheck;

const startedBy = { id: "database-check" };

/**
 * Runs the conformance checks against a database, in order, each on its own (one failing goes
 * on to the next, but once no worker starts the rest fail at once): DBOS's tables migrate and a
 * worker starts on its URL, the next store read sees a credential change, and a queued run drains. A
 * database that `pauses` is also checked for a run queued after a `suspend`: the client's
 * query wakes it, and the worker, reconnecting, drains it. Stops the worker it started, and
 * clears its check's credential.
 */
export async function checkDatabase(db: DatabaseUnderTest): Promise<DatabaseCheck[]> {
  const { type, client, timeoutMs = 60_000 } = db;
  const spec = type.database;
  if (!spec) throw new Error(`${type.vendor}.${type.type} does not meet the Database contract: it has no database`);
  const credential = randomBytes(18).toString("base64url");
  const results: DatabaseCheck[] = [];
  let worker: Worker | undefined;
  const check = async (name: string, run: () => Promise<void>) => {
    if (results.length && !worker) return void results.push({ name, ok: false, error: "no worker started" });
    try {
      await run();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: errorMessage(err) });
    }
  };
  const drains = async () => {
    const runId = await client.start("host-check-drain", {}, { startedBy });
    const run = await runEnded(client, runId, timeoutMs);
    if (run?.status !== "finished") throw new Error(`run ${runId} ended ${run?.status}: ${run?.error}`);
  };

  try {
    await check("DBOS's tables migrate and a worker starts on the url", async () => {
      const outputs = spec.outputs(await db.apply());
      if (!outputs.healthy) throw new Error("its state says it is not healthy");
      // Its launch migrates DBOS's tables; a client's first call makes the runtime's.
      worker = await startWorker(databaseCheckConfig(await db.url()), { quiet: true });
      // A value an earlier check left, under another key, would fail the probe.
      await client.clearSecret(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
    });
    await check("the next store read sees a credential change", () =>
      credentialHeard(client, credential, startedBy, timeoutMs),
    );
    await check("a queued run drains", drains);
    if (spec.capabilities.pauses) {
      await check("a queued run drains after a suspend and a wake", async () => {
        if (!db.suspend) throw new Error("a database that pauses needs suspend to be checked");
        await db.suspend();
        // The start is the first query since: it wakes the compute.
        await drains();
      });
    }
  } finally {
    if (worker) await client.clearSecret(HOST_CHECK_CREDENTIAL, { by: startedBy.id }).catch(() => undefined);
    await worker?.stop();
  }
  return results;
}

const fakeSchema = z.object({ name: z.string().regex(/^\w+$/), region: z.string().min(1) });

/**
 * The fake database's type, `testdb.database`: a database of the test Postgres, named by its
 * declaration's `name` (`testDatabaseUrl(name)`), which `fakeDatabase` drives. It pauses (its
 * suspend drops every connection) and does not branch.
 */
export const fakeDatabaseType = defineResource({
  vendor: "testdb",
  type: "database",
  title: "Test database",
  identity: "name",
  schema: fakeSchema,
  fields: { immutable: ["name", "region"], vendorOwned: [], writeOnly: [] },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
  afterCreate: [{ op: "testdb.database.storeUrl", input: ({ id, export: name }) => ({ id, export: name }) }],
  database: {
    capabilities: { pauses: true, branch: false },
    inputs: { region: "region" },
    storeUrl: "testdb.database.storeUrl",
    regions: ["local"],
    outputs: (state) => ({ healthy: typeof state.name === "string" }),
  },
});

const types = defineConnector(
  "testdb",
  { database: fakeDatabaseType },
  {
    title: "Test database",
    // Only what a data file imports it from: no such package is published.
    package: "@sanoma-ai/testing-database",
  },
);
const store = defineConnector("testdb", {
  database: {
    storeUrl: {
      effect: "write",
      idempotent: true,
      description: "Store the database's URL as the secret SANOMA_DATABASE_URL_<EXPORT>, never returned",
      input: z.object({ id: z.string().min(1), export: z.string().regex(/^[A-Za-z_]\w*$/) }),
      output: z.object({ secret: z.string() }),
      target: ({ id }) => id,
    },
  },
});
/** The fake database's operations: the type's, and `database.storeUrl` in its group (Supabase's pattern). */
const fakeDatabaseOps = { ...types, database: { ...types.database, ...store.database } } as FakeDatabaseOps;

/** The fake database's connector type: the database type with `database.storeUrl`. */
export type FakeDatabaseOps = typeof types & typeof store;

/** Runs `sql` on the test Postgres's `postgres` database. */
async function admin<T>(sql: (db: Client) => Promise<T>): Promise<T> {
  const url = new URL(testDatabaseUrl("admin"));
  url.pathname = "/postgres";
  const db = new Client({ connectionString: url.href });
  await db.connect();
  try {
    return await sql(db);
  } finally {
    await db.end();
  }
}

/** The name of `testDatabaseUrl(name)`'s database on the server. */
const databaseName = (name: string) => decodeURIComponent(new URL(testDatabaseUrl(name)).pathname.slice(1));

/** Postgres's codes for a database made already: 42P04, or 23505 when two creates race. */
const MADE_ALREADY = new Set(["42P04", "23505"]);

const readDatabase = async ({ id }: { id: string }) => {
  const { rowCount } = await admin((db) =>
    db.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName(id)]),
  );
  return rowCount ? { id, gone: false, state: { name: id, region: "local" } } : { id, gone: true };
};
const dropDatabase = (id: string) =>
  admin((db) => db.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName(id))} WITH (FORCE)`));

const typeDriver = defineDriver(types, {
  database: {
    import: readDatabase,
    read: readDatabase,
    plan: async ({
      id,
      desired,
    }): Promise<{ action: PlanAction; planned?: State; unknown: string[]; replace: string[] }> => {
      const now = id === undefined ? undefined : await readDatabase({ id });
      const exists = now !== undefined && !now.gone;
      if (!desired) return { action: exists ? "delete" : "none", unknown: [], replace: [] };
      return { action: exists ? "none" : "create", planned: desired, unknown: [], replace: [] };
    },
    create: async ({ desired }) => {
      const declared = fakeSchema.parse(desired);
      await admin((db) => db.query(`CREATE DATABASE ${escapeIdentifier(databaseName(declared.name))}`)).catch(
        (err: unknown) => {
          if (!MADE_ALREADY.has((err as { code?: string }).code ?? "")) throw err;
        },
      );
      return { id: declared.name, state: declared };
    },
    update: async ({ desired }) => ({ id: String(desired.name), state: fakeSchema.parse(desired) }),
    delete: async ({ id }) => {
      await dropDatabase(id);
      return { id, gone: true as const };
    },
  },
});
const storeDriver = defineDriver(store, {
  database: {
    storeUrl: async ({ id, export: name }, { secrets }: CallContext) =>
      storeDatabaseUrl(secrets, name, testDatabaseUrl(id), {
        where: "testdb: database.storeUrl",
        others: "another database",
      }),
  },
});
/** The fake database's driver: its type's operations, and `database.storeUrl`. */
const driver: Driver = Object.freeze({
  ...typeDriver,
  ops: Object.freeze({ ...typeDriver.ops, ...storeDriver.ops }),
});

/**
 * A database in this process: `testdb.database`, whose driver makes `testDatabaseUrl(name)` on
 * the test Postgres for a create, drops it for a delete, and stores its URL for `storeUrl`.
 * `apply()` makes the one declared as `name` (default `database_kit`) when it is not there,
 * `url()` is its URL, `suspend()` drops every other connection to it, so the next query
 * connects again, as a Neon compute's suspend does; `remove()` drops it. `connector` is for a
 * config, `driver` for calling its operations directly.
 */
export function fakeDatabase(name = "database_kit") {
  return {
    type: fakeDatabaseType,
    connector: withSetup(fakeDatabaseOps, { driver: () => driver }),
    driver,
    /** Makes the database `name` when it is not there; returns its state. */
    async apply(): Promise<State> {
      const call = { idempotencyKey: name, runId: "fake", opId: "testdb.database.create", attempt: 1 } as CallContext;
      const made = (await driver.ops["database.create"]!({ desired: { name, region: "local" } }, call)) as {
        state: State;
      };
      return made.state;
    },
    url: async () => testDatabaseUrl(name),
    /** Drops every connection to the database: the next query connects again. Resolves to how many it dropped. */
    async suspend(): Promise<number> {
      const { rowCount } = await admin((db) =>
        db.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName(name)],
        ),
      );
      return rowCount ?? 0;
    },
    /** Drops the database `name`. */
    remove: () => dropDatabase(name).then(() => undefined),
  };
}
