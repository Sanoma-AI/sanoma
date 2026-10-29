import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { checkHost, hostCheck, hostCheckWorkflows, inProcessHost, testRepository } from "@sanoma-ai/testing/host";
import {
  type CallContext,
  memoryLedger,
  memorySecrets,
  resolveRevision,
  SanomaClient,
  type SanomaConfig,
  withSetup,
} from "@sanoma-ai/workflows";
import { writeLockfile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudflareOps, container } from "../src/connector.ts";
import { fakeCloudflare } from "../src/fake.ts";

// Needs Postgres: `pnpm db:up`. The Host contract's conformance kit against `cloudflare.container`
// on the fake: its Worker served in this process, the package's own object code running the
// company in this process as its container, which the fake stops as Cloudflare does when it is
// quiet. Drift is the built-in workflow over a data file that declares the host, bound in the
// lockfile.

const key = "kit-secret-value-that-never-leaks";
let n = 0;
const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${++n}`,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets({ HOST_KEY: key }),
});

describe("cloudflare.container meets the Host contract on the fake", () => {
  const databaseUrl = testDatabaseUrl("cloudflare_host");
  const repo = testRepository();
  const root = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-host-"));
  const declared = {
    name: "company",
    image: "ghcr.io/sanoma-ai/runtime:0.7.0",
    source: repo.url,
    ref: "main",
    port: 3000,
  };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const fake = fakeCloudflare({
    start: ({ revision, env }) => inProcessHost(config, databaseUrl)({ port: 0, revision, secrets: env }),
  });
  config.connectors.push(withSetup(cloudflareOps, { driver: () => fake.driver }));
  const op = (name: string) => (input: object) =>
    fake.driver.ops[`container.${name}`]!(input, call(`cloudflare.container.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
    await repo.commit();
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";\n\n` +
        `export const host = cloudflare.container(${JSON.stringify(declared)});\n\nexport default [host];\n`,
    );
    writeLockfile(root, { "resources/hosts.ts#host": { type: "cloudflare.container", id: declared.name } });
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    await client?.close();
    await fake.close();
    repo.remove();
    rmSync(root, { recursive: true, force: true });
  });

  /** Apply, as it runs for a host: the revision from the ref, then a plan, then the change it names. */
  async function apply() {
    const desired = { ...declared, secrets: { SANOMA_SECRETS_KEY: secret("HOST_KEY") }, revision: "" };
    desired.revision = await resolveRevision(repo.url, declared.ref);
    const plan = (await op("plan")({ id: declared.name, desired })) as { action: string };
    if (plan.action === "none")
      return ((await op("read")({ id: declared.name })) as { state: Record<string, unknown> }).state;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: declared.name, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it("passes every check, the two of a host that stops among them", { timeout: 300_000 }, async () => {
    const results = await checkHost({
      type: container,
      apply,
      stop: async () => void (await op("delete")({ id: declared.name })),
      suspend: () => fake.stop(declared.name),
      client,
      secrets: [key],
      commit: repo.commit,
      async drift() {
        const report = await client.driftReport(await client.drift({ startedBy: { id: "kit" } }));
        return report.resources.find((r) => r.id === "resources/hosts.ts#host")!;
      },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "the app answers on its port", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "the next store read sees a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      { name: "a queued run drains after a stop and a wake", ok: true },
      { name: "a sleep that ends while stopped continues after a wake", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
    // A deploy started the container again at the new revision, behind the same URL.
    expect(Object.keys(fake.state.scripts)).toEqual(["sanoma-company"]);
    // The ghcr.io image was copied into the account's registry once, and the application runs the copy.
    expect(Object.values(fake.state.images)).toEqual([declared.image]);
    expect(Object.values(fake.state.applications).map((a) => a.image)).toEqual(Object.keys(fake.state.images));
  });
});
