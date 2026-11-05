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
import { fakeCloudflare, stubAppBundle } from "../src/fake.ts";

// Needs Postgres: `pnpm db:up`. The Host contract's conformance kit against `cloudflare.container`
// on the fake: its Worker script served in this process (the package's own `serve` over the app
// bundle the container's worker built, `stubAppBundle`), the package's own object code running the
// company in this process as its container, which the fake stops as Cloudflare does when it is
// quiet. Drift is the built-in workflow over a data file that declares the host, bound in the
// lockfile.

const key = "kit-secret-value-that-never-leaks";
const DATABASE_URL = "postgresql://sanoma:p%40ss@db.acme.example:5432/company";
let n = 0;
/** A call's context over `secrets`, kept across calls as a company's store is: the instance token minted once. */
const caller =
  (secrets = memorySecrets({ HOST_KEY: key, DB_URL: DATABASE_URL })) =>
  (opId: string): CallContext => ({
    idempotencyKey: `${opId}:${++n}`,
    runId: "kit",
    opId,
    attempt: 1,
    secrets,
  });
/** The secrets a host is given: its database's URL, which Hyperdrive goes over. */
const HOST_SECRETS = { SANOMA_DATABASE_URL: secret("DB_URL") };

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
  const call = caller(memorySecrets({ HOST_KEY: key, DB_URL: databaseUrl }));
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
    const desired = {
      ...declared,
      secrets: { SANOMA_SECRETS_KEY: secret("HOST_KEY"), SANOMA_DATABASE_URL: secret("DB_URL") },
      revision: "",
    };
    desired.revision = await resolveRevision(repo.url, declared.ref);
    const plan = (await op("plan")({ id: declared.name, desired })) as { action: string };
    if (plan.action === "none")
      return ((await op("read")({ id: declared.name })) as { state: Record<string, unknown> }).state;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: declared.name, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it(
    "passes every check, the ones of a host that stops and of its pages among them",
    { timeout: 300_000 },
    async () => {
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
        page: "/",
        timeoutMs: 30_000,
      });
      expect(results).toEqual([
        { name: "the app answers on its port", ok: true },
        { name: "a queued run drains", ok: true },
        { name: "the next store read sees a credential change", ok: true },
        { name: "a sleep survives a restart", ok: true },
        { name: "a queued run drains after a stop and a wake", ok: true },
        { name: "a sleep that ends while stopped continues after a wake", ok: true },
        { name: "a page of the app answers while the container is stopped", ok: true },
        { name: "a deploy never answers 503 to a visitor", ok: true },
        { name: "a new commit shows as drift that apply clears", ok: true },
        { name: "no secret is in the ledger", ok: true },
      ]);
      // A deploy started the container again at the new revision, behind the same URL.
      expect(Object.keys(fake.state.scripts)).toEqual(["sanoma-company"]);
      // The ghcr.io image was copied into the account's registry once, and the Worker names the copy, pinned.
      expect(Object.values(fake.state.images)).toEqual([declared.image]);
      expect(Object.values(fake.state.scripts["sanoma-company"]!.images)).toEqual(Object.keys(fake.state.images));
    },
  );
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
    secrets: HOST_SECRETS,
  };
  const fake = fakeCloudflare({ zones: ["acme.example"] });
  const call = caller();
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

  it("attaches the app's hostname beside the domains, serves it as its url, and detaches it once no longer declared", async () => {
    const hostname = "app.acme.example";
    const made = (await op("create", { desired: { ...desired, hostname } })) as { state: Record<string, unknown> };
    expect(made.state).toMatchObject({ hostname, url: `https://${hostname}` });
    const text = () =>
      Object.fromEntries(fake.state.scripts["sanoma-company"]!.bindings.map((b) => [b.name, b.text] as const));
    expect(text()).toMatchObject({ SANOMA_HOSTNAME: hostname });
    // The wakeup reaches the Worker where it answers, never through the hostname.
    expect(text().SANOMA_HOST_URL).toBe(made.state.worker_url);
    const hostnames = () =>
      Object.values(fake.state.domains)
        .map((d) => d.hostname)
        .toSorted();
    expect(hostnames()).toEqual([hostname, "www.acme.example"]);
    expect(await op("read", { id: "company" })).toMatchObject({ state: { hostname, url: `https://${hostname}` } });
    // Detached by hand: drift, which the next update attaches again.
    const id = Object.entries(fake.state.domains).find(([, d]) => d.hostname === hostname)![0];
    delete fake.state.domains[id];
    expect(await op("plan", { id: "company", desired: { ...desired, hostname } })).toMatchObject({ action: "update" });
    await op("update", { id: "company", desired: { ...desired, hostname } });
    expect(hostnames()).toEqual([hostname, "www.acme.example"]);
    // No longer declared: detached, and the app is at workers.dev again.
    const without = (await op("update", { id: "company", desired })) as { state: Record<string, unknown> };
    expect(hostnames()).toEqual(["www.acme.example"]);
    expect(without.state.hostname).toBeUndefined();
    expect(without.state.url).toBe(text().SANOMA_HOST_URL);
    expect(text()).not.toHaveProperty("SANOMA_HOSTNAME");
    await op("delete", { id: "company" });
    expect(fake.state.domains).toEqual({});
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

describe("cloudflare.host's deploy on the fake", () => {
  const desired = {
    name: "company",
    image: "ghcr.io/sanoma-ai/runtime:0.7.0",
    source: "https://github.com/acme/company.git",
    ref: "main",
    revision: "abc123",
    port: 3000,
    secrets: HOST_SECRETS,
  };
  const built: string[] = [];
  const fake = fakeCloudflare({ bundle: (revision) => (built.push(revision), stubAppBundle(revision)) });
  const call = caller();
  const op = (name: string, input: object) => fake.driver.ops[`host.${name}`]!(input, call(`cloudflare.host.${name}`));
  afterAll(() => fake.close());

  it("builds the bundle first, uploads the Worker with it once, and restarts the container at the revision last", async () => {
    const made = (await op("create", { desired })) as { state: Record<string, unknown> };
    expect(built).toEqual(["abc123"]);
    const worker = fake.state.scripts["sanoma-company"]!;
    expect(worker.modules).toEqual(["index.js", "instance.js", "app/index.js"]);
    expect(worker.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(Object.keys(worker.assets!)).toEqual(["/assets/app.js"]);
    // The database through Hyperdrive, over the declared URL; the password never in the state.
    const [id, config] = Object.entries(fake.state.hyperdrives)[0]!;
    expect(config).toEqual({
      name: "sanoma-company",
      origin: { scheme: "postgresql", host: "db.acme.example", port: 5432, database: "company", user: "sanoma" },
    });
    expect(worker.bindings).toContainEqual({ type: "hyperdrive", name: "DATABASE", id });
    expect(worker.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
    // The instance token, minted and bound though not declared.
    expect(worker.bindings).toContainEqual({ type: "secret_text", name: "SANOMA_WAKEUP_TOKEN" });
    expect(await op("plan", { id: "company", desired })).toMatchObject({ action: "none" });

    // A page is the app's, on the Worker, with the visitor's address Cloudflare gave.
    const page = await fetch(String(made.state.worker_url), { headers: { "x-sanoma-client-ip": "10.0.0.1" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("x-sanoma-revision")).toBe("abc123");
    expect(page.headers.get("x-sanoma-client-ip")).toBe("127.0.0.1");
    // The client build straight from the assets.
    expect(await (await fetch(`${made.state.worker_url}/assets/app.js`)).text()).toBe("console.log('sanoma');\n");

    await op("update", { id: "company", desired: { ...desired, revision: "def456" } });
    expect(built).toEqual(["abc123", "def456"]);
    expect((await fetch(String(made.state.worker_url))).headers.get("x-sanoma-revision")).toBe("def456");
    // The session needs none of the assets the account has.
    expect(Object.keys(fake.state.assets)).toHaveLength(1);
    await op("delete", { id: "company" });
    expect(fake.state.hyperdrives).toEqual({});
  });

  it("refuses a host without its database's URL before anything changes", async () => {
    await expect(op("create", { desired: { ...desired, name: "other", secrets: {} } })).rejects.toThrow(
      "no SANOMA_DATABASE_URL among its secrets",
    );
    expect(fake.state.scripts).toEqual({});
  });

  it("confirms a deploy whose upload is made by its restart alone", async () => {
    await op("create", { desired });
    // The plan is none, the approved one an update: the restart, the last step, alone.
    await expect(
      op("update", { id: "company", desired, expect: { action: "update", replace: [] } }),
    ).resolves.toMatchObject({ state: { revision: "abc123", healthy: true } });
    expect(built.filter((r) => r === "abc123")).toHaveLength(2);
    expect(fake.state.scripts["sanoma-company"]!.modules).toContain("app/index.js");
    await op("delete", { id: "company" });
  });
});
