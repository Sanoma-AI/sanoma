import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallContext,
  memoryLedger,
  memorySecrets,
  resolveRevision,
  SanomaClient,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import { writeLockfile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../src/index.ts";
import {
  checkHost,
  fakeHost,
  fakeHostType,
  hostCheck,
  hostCheckWorkflows,
  inProcessHost,
  testRepository,
} from "../src/host.ts";

// Needs Postgres: `pnpm db:up`. The conformance kit against a host in this process: its worker
// stops and starts through the host type's own operations, and drift is the built-in workflow
// over a data file that declares the host, bound in the lockfile.
const databaseUrl = testDatabaseUrl("host_kit");
const key = "kit-secret-value-that-never-leaks";

const call = (opId: string): CallContext => ({
  idempotencyKey: opId,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets({ HOST_KEY: key }),
});

describe("the host conformance kit", () => {
  const repo = testRepository();
  const root = mkdtempSync(join(tmpdir(), "sanoma-host-kit-"));
  const declared = { name: "company", source: repo.url, ref: "main", port: 0 };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const host = fakeHost((input) => inProcessHost(config, databaseUrl)(input));
  config.connectors.push(host.connector);
  const op = (name: string) => (input: object) => host.driver.ops[`app.${name}`]!(input, call(`testhost.app.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
    await repo.commit();
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { testhost } from "@sanoma-ai/testing-host/resources";\n\n` +
        `export const app = testhost.app(${JSON.stringify(declared)});\n\nexport default [app];\n`,
    );
    writeLockfile(root, { "resources/hosts.ts#app": { type: "testhost.app", id: "company" } });
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    await client?.close();
    await host.close();
    repo.remove();
    rmSync(root, { recursive: true, force: true });
  });

  /** Apply, as it will run for a host: the revision from the ref, then a plan, then the change it names. */
  async function apply() {
    const desired = { ...declared, secrets: { SANOMA_SECRETS_KEY: secret("HOST_KEY") }, revision: "" };
    desired.revision = await resolveRevision(repo.url, declared.ref);
    const now = (await op("read")({ id: declared.name })) as { gone: boolean; state?: Record<string, unknown> };
    const plan = (await op("plan")({ id: declared.name, ...now, desired })) as { action: string };
    if (plan.action === "none") return now.state!;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: declared.name, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it("passes every check against a host in this process", async () => {
    const results = await checkHost({
      type: fakeHostType,
      apply,
      stop: async () => void (await op("delete")({ id: declared.name })),
      client,
      secrets: [key],
      commit: repo.commit,
      async drift() {
        const report = await client.driftReport(await client.drift({ startedBy: { id: "kit" } }));
        return report.resources.find((r) => r.id === "resources/hosts.ts#app")!;
      },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "the app answers on its port", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "LISTEN hears a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
  });
});
