import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
    // The ghcr.io image was copied into the account's registry once, and the Worker names the copy, pinned.
    expect(Object.values(fake.state.images)).toEqual([declared.image]);
    expect(Object.values(fake.state.scripts["sanoma-company"]!.images)).toEqual(Object.keys(fake.state.images));
  });
});

describe("cloudflare.container's custom domains on the fake", () => {
  const desired = {
    name: "company",
    image: "ghcr.io/sanoma-ai/runtime:0.7.0",
    source: "https://github.com/acme/company.git",
    ref: "main",
    revision: "abc123",
    port: 3000,
    domains: { www: "www.acme.example" },
  };
  const fake = fakeCloudflare({ zones: ["acme.example"] });
  const op = (name: string, input: object) =>
    fake.driver.ops[`container.${name}`]!(input, call(`cloudflare.container.${name}`));
  afterAll(() => fake.close());

  it("attaches each declared domain at create, detaches one no longer declared, and every declared one at delete, leaving one attached by hand", async () => {
    await op("create", { desired });
    const zone = fake.state.zones["acme.example"];
    expect(Object.values(fake.state.domains)).toEqual([
      { hostname: "www.acme.example", service: "sanoma-company", zone_id: zone },
    ]);
    // Attached by hand and never declared: left alone.
    const byHand = { hostname: "app.acme.example", service: "sanoma-company", zone_id: zone! };
    fake.state.domains.byhand = byHand;
    await op("update", { id: "company", desired: { ...desired, domains: { shop: "shop.acme.example" } } });
    expect(Object.values(fake.state.domains)).toEqual([
      byHand,
      { hostname: "shop.acme.example", service: "sanoma-company", zone_id: zone },
    ]);
    await op("delete", { id: "company" });
    expect(fake.state.domains).toEqual({ byhand: byHand });
  });

  it("refuses a domain whose zone the account does not hold, before the Worker exists", async () => {
    await expect(
      op("create", { desired: { ...desired, domains: { www: "www.other.example" } } }),
    ).rejects.toMatchObject({
      vendorCode: "no_zone",
      message: expect.stringContaining("no zone other.example for the domain www.other.example"),
    });
    expect(fake.state.scripts).toEqual({});
    expect(Object.values(fake.state.domains).map((d) => d.hostname)).not.toContain("www.other.example");
  });
});

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("cloudflare.container's public sites on the fake", () => {
  /** What the container's bundle route answers: one site, its entry and one asset. */
  const bundle = {
    sites: ["www"],
    mainModule: "index.js",
    modules: [{ name: "index.js", type: "esm", content: b64("export default {};\n") }],
    assets: [{ path: "/assets/main-3f2a.js", content: b64("console.log(1);\n") }],
  };
  const asked: string[] = [];
  // A container that builds the bundle on the first ask, as the runtime's route does.
  const fake = fakeCloudflare({
    zones: ["acme.example"],
    async start() {
      let built = false;
      const server = createServer((req, res) => {
        if (req.url === "/healthz") return void res.writeHead(200).end("ok\n");
        if (req.url !== "/__sanoma/sites-bundle") return void res.writeHead(404).end();
        asked.push(req.headers.authorization ?? "");
        // Marked as the route's, as the runtime marks each answer.
        const marked = { "x-sanoma-sites-bundle": "1", "content-type": "application/json" };
        if (!built) return void ((built = true), res.writeHead(202, marked).end("{}"));
        res.writeHead(200, marked).end(JSON.stringify(bundle));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      };
    },
  });
  const op = (name: string, input: object) =>
    fake.driver.ops[`container.${name}`]!(input, call(`cloudflare.container.${name}`));
  afterAll(() => fake.close());

  it("uploads the bundle the container built beside the Worker, its assets once, with the instance token", async () => {
    const desired = {
      name: "company",
      image: "ghcr.io/sanoma-ai/runtime:0.7.0",
      source: "https://github.com/acme/company.git",
      ref: "main",
      revision: "abc123",
      port: 3000,
      domains: { www: "www.acme.example" },
      secrets: { SANOMA_WAKEUP_TOKEN: secret("HOST_KEY") },
    };
    await op("create", { desired });
    expect(asked).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
    const worker = fake.state.scripts["sanoma-company"]!;
    expect(worker.main_module).toBe("sites.js");
    expect(worker.modules).toEqual(["index.js", "instance.js", "sites.js", "sites/index.js"]);
    expect(worker.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
    const [hash] = Object.values(worker.assets!);
    expect(Object.keys(worker.assets!)).toEqual(["/assets/main-3f2a.js"]);
    expect(fake.state.assets).toEqual({ [hash!]: "text/javascript" });
    // A new revision: the container builds again, and the session needs none of the assets it has.
    await op("update", { id: "company", desired: { ...desired, revision: "def456" } });
    expect(fake.state.scripts["sanoma-company"]!.assets).toEqual(worker.assets);
    expect(Object.keys(fake.state.assets)).toEqual([hash]);
  });
});
