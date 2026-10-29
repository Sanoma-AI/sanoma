import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { checkDatabase, databaseCheckConfig, fakeDatabase } from "@sanoma-ai/testing/database";
import { type CallContext, memorySecrets, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { project } from "../src/connector.ts";
import { fakeNeon } from "../src/fake.ts";
import { neon } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. The Database contract's conformance kit against the fake Neon,
// a database of the test Postgres standing in for its project's (`fakeDatabase`): apply creates
// the project on the fake, and a suspend suspends its compute there and drops every connection to
// the stand-in, as Neon's does.

let n = 0;
const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${++n}`,
  runId: "conformance",
  opId,
  attempt: 1,
  secrets: memorySecrets(),
});

describe("neon.project meets the Database contract", () => {
  const db = fakeDatabase("neon_kit");
  const fake = fakeNeon();
  const ops = fake.driver.ops;
  let client: SanomaClient;
  let id: string | undefined;

  beforeAll(async () => {
    // A database of its own for each run: one an earlier run left would hold its runs.
    await db.remove();
    await db.apply();
    client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
  });

  afterAll(async () => {
    await client?.close();
    await db.remove();
  });

  it("passes every check against the fake, with the test Postgres as its database", { timeout: 120_000 }, async () => {
    const apply = async () => {
      if (!id) {
        const desired = { name: "acme-ops", region: "aws-us-east-1" };
        ({ id } = (await ops["project.create"]!({ desired }, call("neon.project.create"))) as { id: string });
      }
      const read = (await ops["project.read"]!({ id }, call("neon.project.read"))) as {
        state: Record<string, unknown>;
      };
      return read.state;
    };
    const suspend = async () => {
      const { state } = (await ops["project.read"]!({ id }, call("neon.project.read"))) as {
        state: { default_endpoint_id: string };
      };
      await ops["endpoint.suspend"]!({ project: id, id: state.default_endpoint_id }, call("neon.endpoint.suspend"));
      await db.suspend();
    };
    const results = await checkDatabase({ type: project, apply, url: db.url, suspend, client, timeoutMs: 30_000 });
    expect(results).toEqual([
      { name: "DBOS's tables migrate and a worker starts on the url", ok: true },
      { name: "the next store read sees a credential change", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "a queued run drains after a suspend and a wake", ok: true },
    ]);
    expect(Object.values(fake.state.projects[id!]!.endpoints).map((e) => e.current_state)).toEqual(["idle"]);
  });

  it("is a database type in a config: its storeUrl among the connector's operations", () => {
    expect(() => resolveConfig({ workflows: [], connectors: [neon] })).not.toThrow();
    expect(project.database).toMatchObject({
      capabilities: { pauses: true, branch: true },
      storeUrl: "neon.project.storeUrl",
    });
  });
});

describe("neon.project in a data file", () => {
  it("declares the project going live writes, which the config reads with no problem", () => {
    const root = mkdtempSync(join(tmpdir(), "neon-declared-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "infra.ts"),
      [
        'import { neon } from "@sanoma-ai/connector-neon/resources";',
        "",
        'export const store = neon.project({ name: "acme-ops", region: "aws-eu-central-1", size: "0.25" });',
        "",
      ].join("\n"),
    );
    try {
      const config = { workflows: [], connectors: [neon], root, databaseUrl: testDatabaseUrl("neon_declared") };
      expect(describeConfig(config).problems).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
