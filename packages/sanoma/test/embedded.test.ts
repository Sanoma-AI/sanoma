import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { prepareDatabase } from "../../workflows/src/db.ts";
import { type EnsuredPostgres, ensurePostgres } from "../src/postgres.ts";
import { postgresBin } from "../src/postgres-bin.ts";

// The real PostgreSQL 18 of this platform's @sanoma-ai/postgres-<platform> package, filled by
// `pnpm postgres:download` (CI fills all five): without it the tests skip here, and fail in CI.
const archive = join(import.meta.dirname, `../../postgres-bin/${process.platform}-${process.arch}/postgres.tar.gz`);
const binaries = existsSync(archive);

const root = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-embedded-")));
execFileSync("git", ["init", "--quiet", root]);
const cluster = join(root, ".sanoma/postgres");

/** Runs each statement on `database` of the cluster at `databaseUrl`, in one session, and returns the last one's rows. */
async function query(
  databaseUrl: string,
  sql: string | string[],
  database = "sanoma",
): Promise<Record<string, unknown>[]> {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    let rows: Record<string, unknown>[] = [];
    for (const statement of [sql].flat()) rows = (await client.query(statement)).rows;
    return rows;
  } finally {
    await client.end();
  }
}

let last: EnsuredPostgres | undefined;
afterAll(async () => {
  await last?.stop().catch(() => {});
  if (existsSync(join(cluster, "data/postmaster.pid"))) {
    execFileSync(join(postgresBin(), "bin/pg_ctl"), ["stop", "-D", join(cluster, "data"), "-m", "immediate"]);
  }
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!binaries && !process.env.CI)("ensurePostgres on PostgreSQL 18", () => {
  it("creates the company's own, which the runtime prepares and a preview copies, then finds it, stops it and starts it again with the records kept, after a kill too", async () => {
    const created = await ensurePostgres(undefined, { root });
    last = created;
    expect(created.how).toBe("created");
    expect(new URL(created.databaseUrl).hostname).toBe("127.0.0.1");
    await prepareDatabase(created.databaseUrl);
    await query(created.databaseUrl, "CREATE TABLE kept (note text); INSERT INTO kept VALUES ('before')");

    // A preview's copy, once nothing else is connected to the template: a clone where the file
    // system has one (APFS, XFS, Btrfs), else a copy.
    const sessions = "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = 'sanoma'";
    while (((await query(created.databaseUrl, sessions, "postgres"))[0]!.n as number) > 0)
      await new Promise((r) => setTimeout(r, 100));
    const copy = (method: string) =>
      query(
        created.databaseUrl,
        [`SET file_copy_method = ${method}`, "CREATE DATABASE p TEMPLATE sanoma STRATEGY FILE_COPY"],
        "postgres",
      );
    await copy("clone").catch(() => copy("copy"));
    expect(await query(created.databaseUrl, "SELECT note FROM kept", "p")).toEqual([{ note: "before" }]);

    // Another launcher's call: the same cluster, which its stop leaves up.
    const second = await ensurePostgres(undefined, { root, start: false });
    expect(second).toMatchObject({ how: "answered", databaseUrl: created.databaseUrl });
    await second.stop();
    expect(await query(created.databaseUrl, "SELECT 1 AS one")).toEqual([{ one: 1 }]);

    await created.stop();
    expect(existsSync(join(cluster, "data/postmaster.pid"))).toBe(false);
    const started = await ensurePostgres(undefined, { root });
    last = started;
    expect(started).toMatchObject({ how: "started", databaseUrl: created.databaseUrl });
    expect(await query(started.databaseUrl, "SELECT note FROM kept")).toEqual([{ note: "before" }]);

    // Killed, its postmaster.pid left behind: started again, recovering.
    const pid = Number(readFileSync(join(cluster, "data/postmaster.pid"), "utf8").split("\n")[0]);
    process.kill(pid, "SIGKILL");
    while (isAlive(pid)) await new Promise((r) => setTimeout(r, 50));
    const recovered = await ensurePostgres(undefined, { root });
    last = recovered;
    expect(recovered.how).toBe("started");
    expect(await query(recovered.databaseUrl, "SELECT note FROM kept")).toEqual([{ note: "before" }]);
    await recovered.stop();
    last = undefined;
    expect(existsSync(join(cluster, "data/postmaster.pid"))).toBe(false);
  }, 180_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
