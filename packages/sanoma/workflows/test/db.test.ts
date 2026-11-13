import { DBOS } from "@dbos-inc/dbos-sdk";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "sanoma/testing";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  connectMaking,
  databaseOn,
  lazyDb,
  pgCode,
  prepareDatabase,
  readRunChecks,
  spendInviteRequest,
  underPreparationLock,
  writeRunChecks,
} from "../src/db.ts";
import * as companyModule from "../src/db/company.ts";
import { inviteRequests, wakeup } from "../src/db/company.ts";
import { applyMigrations, COMPANY_MIGRATIONS, migrationsApplied, WAKEUP_MIGRATIONS } from "../src/db/migrate.ts";
import * as wakeupModule from "../src/db/wakeup.ts";
import { wakeupAccounts, wakeupInstances } from "../src/db/wakeup.ts";

const databaseUrl = testDatabaseUrl("db");
const pool = new Pool({ connectionString: databaseUrl });
const db = databaseOn(pool);
afterAll(() => pool.end());

/** `db.ts` loaded again, its `prepared` registry empty: another process's view of a database. One at a time. */
async function freshModule(): Promise<typeof import("../src/db.ts")> {
  vi.resetModules();
  return await import("../src/db.ts");
}

describe("pgCode", () => {
  it("is the error's Postgres code, or empty", () => {
    expect(pgCode(Object.assign(new Error("dup"), { code: "23505" }))).toBe("23505");
    expect(pgCode(new Error("plain"))).toBe("");
    expect(pgCode(undefined)).toBe("");
  });
});

describe("databaseOn", () => {
  it("throws the pg error itself, with its code and without the statement's parameters", async () => {
    await prepareDatabase(databaseUrl);
    const sentinel = `sealed-${Date.now()}`;
    const failing = db.insert(inviteRequests).values({ nonce: sentinel, expiresAt: sql`'not a time'` });
    const err = await failing.then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err).toBeDefined();
    expect(err!.code).toBe("22007");
    expect(pgCode(err)).toBe("22007");
    expect(err!.message).not.toContain(sentinel);
    expect(err!.message).not.toContain("Failed query");
    // The same for a statement written out (Postgres's own message carries no value here; its
    // DETAIL, which `message` leaves out, does).
    const spend = sql`INSERT INTO sanoma_invite_requests (nonce, expires_at) VALUES (${sentinel}, now())`;
    await db.execute(spend);
    const raw = await db.execute(spend).catch((e: unknown) => e as Error);
    expect(pgCode(raw)).toBe("23505");
    expect((raw as Error).message).not.toContain(sentinel);
    expect((raw as Error).message).not.toContain("Failed query");
  });

  it("reads the schema's columns in snake_case, and a timestamp as a Date", async () => {
    await prepareDatabase(databaseUrl);
    const [row] = await db.select({ at: wakeup.stoppedAt, id: wakeup.id }).from(wakeup);
    expect(row).toEqual({ at: expect.toSatisfy((v: unknown) => v === null || v instanceof Date), id: 1 });
    expect(getTableName(wakeup)).toBe("sanoma_wakeup");
  });
});

describe("spendInviteRequest", () => {
  it("spends a nonce once, whichever connection asks, and forgets it once it expires", async () => {
    await prepareDatabase(databaseUrl);
    const nonce = `n-${Date.now()}`;
    const later = new Date(Date.now() + 60_000);
    // Two requests at once, as two processes would be: one mints.
    const [a, b] = await Promise.all([spendInviteRequest(db, nonce, later), spendInviteRequest(db, nonce, later)]);
    expect([a, b].toSorted()).toEqual([false, true]);
    expect(await spendInviteRequest(db, nonce, later)).toBe(false);
    // A nonce just expired is kept a while longer, since the database's clock may run ahead of the
    // app's; one an hour past goes on the next spend.
    const stale = "UPDATE sanoma_invite_requests SET expires_at = now() - $2::interval WHERE nonce = $1";
    await pool.query(stale, [nonce, "1 second"]);
    expect(await spendInviteRequest(db, `other-${nonce}`, later)).toBe(true);
    expect((await pool.query("SELECT 1 FROM sanoma_invite_requests WHERE nonce = $1", [nonce])).rowCount).toBe(1);
    await pool.query(stale, [nonce, "61 minutes"]);
    expect(await spendInviteRequest(db, `third-${nonce}`, later)).toBe(true);
    expect((await pool.query("SELECT 1 FROM sanoma_invite_requests WHERE nonce = $1", [nonce])).rowCount).toBe(0);
  });
});

describe("lazyDb", () => {
  it("prepares the database once per process, tries again after a failure, and is final once closed", async () => {
    const url = testDatabaseUrl("db_lazy");
    const migrate = vi.spyOn(DBOS, "migrate");
    migrate.mockRejectedValueOnce(new Error("Postgres is down"));
    const first = lazyDb(url, "first");
    const second = lazyDb(url, "second");
    try {
      await expect(first.db()).rejects.toThrow("could not prepare the database: Postgres is down");
      // Forgotten, so the next use prepares again, once for both.
      const [a, b] = await Promise.all([first.db(), second.db()]);
      expect(a).not.toBe(b);
      expect(await second.db()).toBe(b);
      expect(migrate).toHaveBeenCalledTimes(2);
      expect((await a.execute(sql`SELECT to_regclass('sanoma_ledger')::text AS t`)).rows).toEqual([
        { t: "sanoma_ledger" },
      ]);
    } finally {
      await first.close();
      await second.close();
    }
    await expect(first.db()).rejects.toThrow("the first store is closed");
    await first.close();
  });
});

describe("prepareDatabase", () => {
  it("applies every migration once, records each in the journal table, and two processes preparing one database both succeed", async () => {
    const url = testDatabaseUrl("db_fresh");
    const admin = await connectMaking(url);
    try {
      await admin.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS dbos CASCADE",
      );
      // Each in a module instance of its own, as two processes would be.
      const one = await freshModule();
      const two = await freshModule();
      const three = await freshModule();
      await Promise.all([one.prepareDatabase(url), two.prepareDatabase(url)]);
      const fresh = databaseOn(admin);
      expect(await migrationsApplied(fresh, COMPANY_MIGRATIONS)).toBe(true);
      const { rows } = await admin.query<{ hash: string; created_at: string }>(
        "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );
      expect(rows.map((r) => Number(r.created_at))).toEqual(COMPANY_MIGRATIONS.journal.entries.map((e) => e.when));
      expect((await admin.query("SELECT * FROM sanoma_wakeup")).rows).toEqual([
        { id: 1, at: null, stopped_at: null, last_error: null },
      ]);
      await expect(admin.query("INSERT INTO sanoma_wakeup (id) VALUES (2)")).rejects.toMatchObject({ code: "23514" });
      // Prepared again on a new instance: nothing to apply, nothing recorded twice.
      await three.prepareDatabase(url);
      expect((await admin.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows).toEqual([
        { n: COMPANY_MIGRATIONS.journal.entries.length },
      ]);
    } finally {
      await admin.end();
    }
  });

  it("sets the database's idle-transaction timeout, which DBOS is told not to set per connection", async () => {
    await prepareDatabase(databaseUrl);
    // A session that starts after: the pool's connections so far may predate it.
    const conn = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      expect((await conn.query("SHOW idle_in_transaction_session_timeout")).rows).toEqual([
        { idle_in_transaction_session_timeout: "1min" },
      ]);
    } finally {
      await conn.end();
    }
  });

  it("only checks, in a process that never migrates, and refuses a database behind the journal", async () => {
    const url = testDatabaseUrl("db_check_only");
    const admin = await connectMaking(url);
    try {
      await admin.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS dbos CASCADE",
      );
      const checking = await freshModule();
      const making = await freshModule();
      checking.checkPreparedOnly("the container");
      await expect(checking.prepareDatabase(url)).rejects.toThrow(
        "the database has no DBOS's and Sanoma's tables yet: the container makes them, and this process never does",
      );
      await making.prepareDatabase(url);
      // Behind by one migration: the journal table knows an older newest.
      await admin.query(
        "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)",
      );
      await expect(checking.prepareDatabase(url)).rejects.toThrow("the database has no Sanoma's tables yet");
      expect(await migrationsApplied(databaseOn(admin), COMPANY_MIGRATIONS)).toBe(false);
      // Ahead of the journal (a newer release migrated it): prepared, since every entry is there.
      const last = COMPANY_MIGRATIONS.journal.entries.at(-1)!.when;
      await admin.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('ours', $1), ('later', $2)",
        [last, last + 1],
      );
      expect(await migrationsApplied(databaseOn(admin), COMPANY_MIGRATIONS)).toBe(true);
      await checking.prepareDatabase(url);
      // A middle entry missing while the newest is there (what the migrator skips): not prepared.
      await admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1", [
        COMPANY_MIGRATIONS.journal.entries[0]!.when,
      ]);
      expect(await migrationsApplied(databaseOn(admin), COMPANY_MIGRATIONS)).toBe(false);
      // An empty journal table: nothing applied.
      await admin.query("DELETE FROM drizzle.__drizzle_migrations");
      expect(await migrationsApplied(databaseOn(admin), COMPANY_MIGRATIONS)).toBe(false);
    } finally {
      await admin.end();
    }
  });
});

describe("underPreparationLock", () => {
  it("makes a service's tables beside a company's, each folder with its own journal table", async () => {
    await prepareDatabase(databaseUrl);
    const wakeupTables = () =>
      underPreparationLock(databaseUrl, (locked) => applyMigrations(locked, WAKEUP_MIGRATIONS));
    await Promise.all([wakeupTables(), wakeupTables()]);
    expect(await migrationsApplied(db, WAKEUP_MIGRATIONS)).toBe(true);
    expect(await migrationsApplied(db, COMPANY_MIGRATIONS)).toBe(true);
    const { rows } = await pool.query<{ t: string | null }>(
      "SELECT to_regclass($1)::text AS t UNION ALL SELECT to_regclass($2)::text",
      [getTableName(wakeupAccounts), getTableName(wakeupInstances)],
    );
    expect(rows.map((r) => r.t)).toEqual(["sanoma_wakeup_accounts", "sanoma_wakeup_instances"]);
  });
});

describe("row-level security", () => {
  it("is on, with no policy, on every table the migrations make: their owner reads and writes, another role granted everything reads no row and inserts, updates or deletes none", async () => {
    // A login that is no superuser makes the tables and so owns them, as a hosted company's does
    // (Neon's `neondb_owner`, Supabase's `postgres`); a second login is granted every privilege on
    // them, as Supabase grants its API's roles. Schemas and roles only: dropping a database waits
    // for a checkpoint.
    const url = testDatabaseUrl("db_rls");
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    // Roles are the cluster's: named after the database, cut to fit Postgres's 63 bytes.
    const [owner, other] = [`${name.slice(0, 57)}_owner`, `${name.slice(0, 57)}_other`];
    const password = randomUUID();
    const as = (role: string) => Object.assign(new URL(url), { username: role, password }).href;
    const admin = await connectMaking(url);
    const reset = async () => {
      for (const role of [other, owner]) {
        if ((await admin.query("SELECT FROM pg_roles WHERE rolname = $1", [role])).rowCount)
          await admin.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
      }
      await admin.query("DROP SCHEMA IF EXISTS public, drizzle, dbos CASCADE; CREATE SCHEMA public");
    };
    // Pools connect at their first query, once the roles are made.
    const ownerPool = new Pool({ connectionString: as(owner) });
    const otherPool = new Pool({ connectionString: as(other) });
    try {
      await reset();
      for (const role of [owner, other]) await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT CREATE ON DATABASE "${name}" TO "${owner}"; ALTER SCHEMA public OWNER TO "${owner}"`);

      await prepareDatabase(as(owner));
      // The wakeup service's tables, which may be in a company's database.
      await underPreparationLock(as(owner), (locked) => applyMigrations(locked, WAKEUP_MIGRATIONS));

      // Every table the migrations make has it on, owned by the login that made them, with no
      // FORCE and no policy: a table added without it fails here.
      const ours = [companyModule, wakeupModule]
        .flatMap((tables) => Object.values(tables))
        .filter((t) => is(t, PgTable))
        .map((t) => getTableName(t));
      const { rows: made } = await ownerPool.query<{ name: string; on: boolean; forced: boolean; owner: string }>(
        `SELECT relname AS name, relrowsecurity AS on, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`,
      );
      expect(made.map((t) => t.name)).toEqual(ours.toSorted());
      expect(made.filter((t) => !t.on || t.forced || t.owner !== owner)).toEqual([]);
      expect((await ownerPool.query("SELECT FROM pg_policies")).rowCount).toBe(0);

      // The owner reads and writes through the stores as ever.
      const ownerDb = databaseOn(ownerPool);
      const later = new Date(Date.now() + 60_000);
      expect(await spendInviteRequest(ownerDb, "n-1", later)).toBe(true);
      expect(await spendInviteRequest(ownerDb, "n-1", later)).toBe(false);
      await writeRunChecks(ownerDb, "run-1", { error: "none yet" });
      expect(await readRunChecks(ownerDb, "run-1")).toEqual({ error: "none yet" });

      // Another role, granted every privilege, reads no row of any table and inserts, updates and
      // deletes none (TRUNCATE, TRIGGER and REFERENCES are not row-level: a grant of them is not stopped).
      await ownerPool.query(
        `GRANT USAGE ON SCHEMA public TO "${other}"; GRANT ALL ON ALL TABLES IN SCHEMA public TO "${other}"`,
      );
      for (const table of ours) {
        expect((await otherPool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows, table).toEqual([{ n: 0 }]);
      }
      await expect(
        otherPool.query("INSERT INTO sanoma_invite_requests (nonce, expires_at) VALUES ('n-2', now())"),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await otherPool.query("UPDATE sanoma_wakeup SET last_error = 'x'")).rowCount).toBe(0);
      expect((await otherPool.query("DELETE FROM sanoma_run_checks")).rowCount).toBe(0);
      // What it could not see is there, unchanged.
      expect((await ownerPool.query("SELECT nonce FROM sanoma_invite_requests")).rows).toEqual([{ nonce: "n-1" }]);
      expect((await ownerPool.query("SELECT last_error FROM sanoma_wakeup")).rows).toEqual([{ last_error: null }]);
      expect(await readRunChecks(ownerDb, "run-1")).toEqual({ error: "none yet" });
    } finally {
      await Promise.all([ownerPool.end(), otherPool.end()]);
      await reset().finally(() => admin.end());
    }
  });
});
