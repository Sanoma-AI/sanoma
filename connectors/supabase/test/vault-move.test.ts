import { randomUUID } from "node:crypto";
import { testDatabaseUrl, waitFor } from "sanoma/testing";
import { SanomaClient, type SanomaConfig, startWorker } from "sanoma/workflows";
import { escapeIdentifier, Pool as RealPool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Needs Postgres: `pnpm db:up`. A move between the built-in store and Supabase Vault, both ways,
// through the `migrate-store` run on a worker. Vault is an in-memory stand-in for sql/vault.sql's
// `sanoma_vault.access` (its grants, versions, conflicts), behind the adapter's real transport.

const vault = vi.hoisted(() => {
  const granted = new Set(["live", "sanoma-move-check", "sanoma-move-check-other"]);
  const items = new Map<string, { value: string; version: string; updatedAt: string; updatedBy: string }>();
  function access(params: unknown[]) {
    const [op, ns, path, value, expected, by] = params as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    if (!granted.has(ns)) throw Object.assign(new Error("synthetic provider detail"), { code: "42501" });
    if (op === "validate") return { protocol: 1, writable: true };
    const key = `${ns}\0${path}`;
    const item = items.get(key);
    if (op === "read") return item ?? null;
    if ((item?.version ?? null) !== expected || (op === "delete" && !item))
      throw Object.assign(new Error("synthetic provider detail"), { code: "SV002" });
    if (op === "delete") return (items.delete(key), null);
    const next = {
      value: value!,
      version: (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", ""),
      updatedAt: new Date().toISOString(),
      updatedBy: by!,
    };
    items.set(key, next);
    return next;
  }
  return { items, access };
});
vi.mock("pg", async (original) => {
  const pg = await original<typeof import("pg")>();
  class Pool extends pg.Pool {
    readonly #vault: boolean;
    constructor(config?: import("pg").PoolConfig) {
      super(config);
      this.#vault = config?.connectionString?.startsWith("postgres://vault-fake") ?? false;
    }
    override query(...args: any[]): any {
      if (!this.#vault) return (super.query as (...a: any[]) => any)(...args);
      return Promise.resolve().then(() => ({ rows: [{ result: vault.access(args[1] as unknown[]) }] }));
    }
  }
  return { ...pg, Pool };
});
const { supabaseVault } = await import("../src/vault.ts");

const SENTINEL = `plaintext-sentinel-${randomUUID()}`;
const databaseUrl = testDatabaseUrl("supabase_vault_move");
const bindings = { PLAIN: { path: "plain/value", management: "sanoma" } } as const;
const vaultStore = supabaseVault();
const builtinFirst: SanomaConfig = {
  databaseUrl,
  connectors: [],
  secrets: { namespace: "live", bindings, stores: { vault: { store: vaultStore, namespace: "live" } } },
};
const vaultFirst: SanomaConfig = {
  databaseUrl,
  connectors: [],
  secrets: { store: vaultStore, namespace: "live", bindings, stores: { builtin: { namespace: "live" } } },
};

/** A worker and client on `config` for the length of `use`. */
async function on<T>(config: SanomaConfig, use: (client: SanomaClient) => Promise<T>): Promise<T> {
  const worker = await startWorker(config);
  const client = await SanomaClient.connect(config);
  try {
    return await use(client);
  } finally {
    await client.close();
    await worker.stop();
  }
}
/** Starts a move to `to` and returns once its copies are verified: the code switch is what it waits on. */
const startMove = (client: SanomaClient, to: string) =>
  client.start("migrate-store", { to, retainHours: 0 }, { startedBy: "alice" }).then(async (runId) => {
    await waitFor(async () => (await client.storeMoves({ actor: "alice" }))[0]?.phase === "verified", Boolean, 30_000);
    return runId;
  });

beforeAll(async () => {
  vi.stubEnv("SUPABASE_VAULT_DATABASE_URL", "postgres://vault-fake@localhost/vault");
  const server = new URL(databaseUrl);
  server.pathname = "/postgres";
  const admin = new RealPool({ connectionString: server.toString() });
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${escapeIdentifier(new URL(databaseUrl).pathname.slice(1))} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
});
afterAll(() => vaultStore.close());

describe("moving secrets between the built-in store and Supabase Vault", () => {
  it("moves builtin → Vault → builtin through migrate-store, and no value lands in Postgres's tables", async () => {
    const there = await on(builtinFirst, async (client) => {
      await client.setSecret("PLAIN", `plain-${SENTINEL}`, { by: "alice" });
      const runId = await startMove(client, "vault");
      await expect(client.setSecret("PLAIN", "late", { by: "alice" })).rejects.toThrow(/read.only/);
      return runId;
    });
    const back = await on(vaultFirst, async (client) => {
      expect(await client.result(there, 60_000)).toEqual({ phase: "retired", retired: ["PLAIN"] });
      const read = (await client.secrets(["PLAIN"])).get("PLAIN");
      expect(read).toMatchObject({ value: `plain-${SENTINEL}`, location: { store: "supabase-vault" } });
      expect(vault.items.get("live\0plain/value")?.updatedBy).toBe(`move:${there}`);
      // Vault takes writes now; the next move carries the newer value back.
      await client.setSecret("PLAIN", `plain-2-${SENTINEL}`, { by: "alice" });
      return startMove(client, "builtin");
    });
    await on(builtinFirst, async (client) => {
      expect(await client.result(back, 60_000)).toEqual({ phase: "retired", retired: ["PLAIN"] });
      expect((await client.secrets(["PLAIN"])).get("PLAIN")).toMatchObject({
        value: `plain-2-${SENTINEL}`,
        location: { store: "postgres" },
      });
      await client.setSecret("PLAIN", "writable again", { by: "alice" });
      expect((await client.storeMoves({ actor: "alice" })).map((m) => [m.destinationName, m.phase])).toEqual([
        ["builtin", "retired"],
        ["vault", "retired"],
      ]);
    });
    // Retired from Vault, and nothing in the check namespaces left behind.
    expect([...vault.items.keys()]).toEqual([]);
    const pg = new RealPool({ connectionString: databaseUrl });
    try {
      const { rows: columns } = await pg.query<{ s: string; t: string; c: string }>(
        `SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.columns
         WHERE table_schema IN ('dbos', 'public') AND data_type IN ('text', 'jsonb', 'json', 'character varying')`,
      );
      const found: string[] = [];
      for (const { s, t, c } of columns) {
        const hit = await pg.query(
          `SELECT 1 FROM ${escapeIdentifier(s)}.${escapeIdentifier(t)} WHERE ${escapeIdentifier(c)}::text LIKE $1 LIMIT 1`,
          [`%${SENTINEL}%`],
        );
        if (hit.rows.length) found.push(`${s}.${t}.${c}`);
      }
      expect(columns.length).toBeGreaterThan(10);
      expect(found).toEqual([]);
    } finally {
      await pg.end();
    }
  }, 180_000);
});
