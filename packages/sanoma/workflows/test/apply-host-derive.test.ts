import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { github as githubConnector } from "@sanoma-ai/connector-github";
import { fakeGithub } from "@sanoma-ai/connector-github/fake";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { testRepository } from "sanoma/testing/host";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LOCKFILE, writeLockfile } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import {
  type ApplyInput,
  defineConnector,
  defineResource,
  memoryLedger,
  sourceKeyId,
  sourceKeyPair,
  withSetup,
  resolveSecrets,
} from "../src/index.ts";
import { memorySecretStore } from "../src/secret-store.ts";
import { ALICE, rootWith } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. Apply on a host that derives (`deriveHosts`), as sanoma-ops
// declares one: the GitHub repository in a file of its own, the host in `resources/sanoma/infra.ts`,
// the source key bound `{ env }`, over GitHub's fake and a host kept in memory.

type State = Record<string, unknown>;

const app = defineResource({
  vendor: "acmehost",
  type: "app",
  title: "App",
  identity: "name",
  schema: z.object({
    name: z.string(),
    source: z.string().nullish(),
    ref: z.string().nullish(),
    revision: z.string().nullish(),
    secrets: z.record(z.string(), z.string()).nullish(),
    domains: z.record(z.string(), z.string()).nullish(),
  }),
  fields: {
    immutable: ["name"],
    vendorOwned: [],
    writeOnly: ["secrets"],
    references: { source: { type: "github.repository", by: ["http_clone_url"] } },
  },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
  host: {
    capabilities: { lifetime: "stops-on-exit", publicUrl: true, buildsFromGit: false, staticEgress: false },
    derives: true,
    inputs: { source: "source", ref: "ref", secrets: "secrets", domains: "domains" },
    revision: "revision",
    outputs: (state) => ({ url: `https://${String(state.name)}.acme.example`, healthy: true }),
  },
});
const types = defineConnector("acmehost", { app }, { title: "Acme host", package: "@acme/host" });

/** A change to the host, which no test here expects. */
const unexpected = async () => {
  throw new Error("acmehost: no change was expected");
};

/** Apps by name; writes are refused unless a test captures trusted secret delivery. */
function fakeAcmeHost(delivered?: Record<string, unknown>) {
  const fake = defineFake(types, {
    initial: () => ({ apps: new Map<string, State>() }),
    ops: (state) => {
      const read = async ({ id }: { id: string }) => {
        const held = state.apps.get(id);
        return held ? { id, gone: false, state: held } : { id, gone: true };
      };
      return {
        app: {
          import: read,
          read,
          plan: delivered
            ? async ({ desired }: { desired: State }) => ({
                action: "update",
                planned: { name: desired.name, source: desired.source, ref: desired.ref, revision: desired.revision },
                unknown: [],
                replace: [],
              })
            : unexpected,
          create: unexpected,
          update: delivered
            ? async (
                { id, desired }: { id: string; desired: State },
                ctx: { secrets: Parameters<typeof resolveSecrets>[1] },
              ) => {
                Object.assign(delivered, await resolveSecrets(desired.secrets, ctx.secrets));
                const { secrets: _secrets, ...safe } = desired;
                state.apps.set(id, safe);
                return { id, state: safe };
              }
            : unexpected,
          delete: unexpected,
        },
      } as never;
    },
  });
  // Its driver reads ACME_TOKEN, optional, as a vendor's does on every call.
  const driver = { ...fake.driver, env: z.object({ ACME_TOKEN: z.string().min(1).optional() }) };
  return Object.assign(fake, { connector: withSetup(types, { driver: () => driver, fake: () => fake }) });
}

const REPOSITORY = [
  'import { github } from "@sanoma-ai/connector-github/resources";',
  "",
  'export const company = github.repository({ owner: "acme", name: "company", visibility: "private" });',
  "",
].join("\n");
const INFRA = [
  'import { acmehost } from "@acme/host/resources";',
  "",
  'export const host = acmehost.app({ name: "company" });',
  "",
].join("\n");

describe("the apply workflow on a host that derives", () => {
  const root = rootWith({
    "resources/people.ts": ALICE,
    "resources/identity/github.ts": REPOSITORY,
    "resources/sanoma/infra.ts": INFRA,
  });
  // The repository the app runs from, as sanoma-ops's: its `origin` names the declared repository.
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:acme/company.git"]);
  const pair = sourceKeyPair();
  const github = fakeGithub();
  const host = fakeAcmeHost();
  // The source key is in the environment, bound `{ env }`, as sanoma-ops binds it.
  const before = process.env.TEST_SOURCE_KEY;
  afterAll(() => {
    if (before === undefined) delete process.env.TEST_SOURCE_KEY;
    else process.env.TEST_SOURCE_KEY = before;
  });
  const harness = useTestApp(
    {
      workflows: [],
      connectors: [withSetup(githubConnector, { driver: () => github.driver }), host.connector],
      ledger: memoryLedger(),
      root,
      secrets: { bindings: { SANOMA_SOURCE_KEY: { env: "TEST_SOURCE_KEY" } } },
    },
    { databaseUrl: testDatabaseUrl("apply-host-derive") },
  );
  const hostId = "resources/sanoma/infra.ts#host";
  const keyId = sourceKeyId(hostId);
  const old = "resources/sanoma/infra.ts#deployKey";

  beforeEach(async () => {
    process.env.TEST_SOURCE_KEY = (await pair).privateKey;
    rmSync(join(root, LOCKFILE), { force: true });
    github.reset();
    host.reset();
  });

  /** GitHub holding the host's key already, as id 42 of acme/company: the key a data file of before declared. */
  const keyOnGithub = async () =>
    github.put("repository_deploy_key", "company:42", {
      repository: "company",
      title: "Sanoma host",
      key: (await pair).publicKey,
      read_only: true,
    });

  async function apply(input: ApplyInput) {
    const runId = await harness.client.apply(input, { startedBy: { id: "alice" } });
    return harness.client.applyReport(runId);
  }

  it("takes over the binding of the deploy key its file declared before, which GitHub holds, and makes no second", async () => {
    // sanoma-ops after its `deployKey` export is removed: the old binding left, the same key at GitHub.
    await keyOnGithub();
    writeLockfile(root, { [old]: { type: "github.repository_deploy_key", id: "acme/company:42" } });
    const report = await apply({ only: [keyId, old] });
    expect(report.plan.problems).toEqual([]);
    expect(report.plan.steps).toEqual([
      expect.objectContaining({ id: keyId, action: "bind", binding: "acme/company:42", source: "found", from: old }),
    ]);
    expect(report.results).toEqual([expect.objectContaining({ id: keyId, status: "done" })]);
    expect(JSON.parse(readFileSync(join(root, LOCKFILE), "utf8"))).toEqual({
      [keyId]: { type: "github.repository_deploy_key", id: "acme/company:42" },
    });
    expect(github.calls.filter((c) => c.op.endsWith(".create"))).toEqual([]);
    // The next apply finds it bound, as declared.
    expect((await apply({ only: [keyId] })).plan.steps).toEqual([
      expect.objectContaining({ id: keyId, action: "none", binding: "acme/company:42" }),
    ]);
  });

  it("binds a key GitHub holds that no binding names, instead of making it again", async () => {
    await keyOnGithub();
    const report = await apply({ only: [keyId] });
    expect(report.plan.steps).toEqual([
      expect.objectContaining({ id: keyId, action: "bind", binding: "acme/company:42", source: "found" }),
    ]);
    expect(report.plan.steps[0]).not.toHaveProperty("from");
    expect(JSON.parse(readFileSync(join(root, LOCKFILE), "utf8"))).toEqual({
      [keyId]: { type: "github.repository_deploy_key", id: "acme/company:42" },
    });
  });

  it("leaves a host out, with why, while its vendor's credential is in the environment alone", async () => {
    host.update((state) => {
      state.apps.set("company", { name: "company", ref: "main" });
    });
    process.env.ACME_TOKEN = "acme-token-of-this-machine";
    try {
      const report = await apply({ only: [hostId] });
      expect(report.plan.steps).toEqual([]);
      expect(report.plan.problems).toEqual([
        expect.objectContaining({
          message:
            'host: ACME_TOKEN is read from the environment here, and has no binding, so the host would not be given it: bind it in sanoma.config.ts, `secrets: { bindings: { ACME_TOKEN: { env: "ACME_TOKEN" } } }`, or store it on the acmehost connector page',
        }),
      ]);
    } finally {
      delete process.env.ACME_TOKEN;
    }
  });

  it("changes nothing on a host whose Worker has domains while no site declares one", async () => {
    host.update((state) => {
      state.apps.set("company", { name: "company", ref: "main", domains: { www: "www.acme.example" } });
    });
    const report = await apply({ only: [hostId] });
    expect(report.plan.steps).toEqual([]);
    expect(report.plan.problems).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "www.acme.example (www) is attached and no site declares a domain, so a change would detach it: put `domain` on each site",
        ),
      }),
    ]);
  });
});

describe("explicit host environment delivery through apply", () => {
  const repository = testRepository();
  beforeAll(() => repository.commit());
  afterAll(() => repository.remove());
  const root = rootWith({
    "resources/people.ts": ALICE,
    "resources/sanoma/infra.ts": INFRA.replace(
      'name: "company"',
      `name: "company", source: ${JSON.stringify(repository.url)}, ref: "main"`,
    ),
  });
  const delivered: Record<string, unknown> = {};
  const host = fakeAcmeHost(delivered);
  const value = "provisioning-bootstrap-never-in-history";
  const before = process.env.TEST_HOST_BOOTSTRAP;
  afterAll(() => {
    if (before === undefined) delete process.env.TEST_HOST_BOOTSTRAP;
    else process.env.TEST_HOST_BOOTSTRAP = before;
  });
  const harness = useTestApp(
    {
      workflows: [],
      connectors: [host.connector],
      root,
      secrets: {
        store: memorySecretStore(),
        bindings: {
          RELAY_TOKEN: { env: "TEST_HOST_BOOTSTRAP", host: true },
          LOCAL_ONLY: { env: "TEST_LOCAL_ONLY" },
          NOT_DELIVERED: { env: "TEST_NOT_DELIVERED", host: false },
        },
      },
    },
    { databaseUrl: testDatabaseUrl("host-environment") },
  );

  beforeEach(() => {
    process.env.TEST_HOST_BOOTSTRAP = value;
    for (const name of Object.keys(delivered)) delete delivered[name];
    rmSync(join(root, LOCKFILE), { force: true });
    host.reset();
    host.update((state) => state.apps.set("company", { name: "company" }));
    writeLockfile(root, { "resources/sanoma/infra.ts#host": { type: "acmehost.app", id: "company" } });
  });

  it("delivers an alias only at the driver boundary and excludes values from durable history", async () => {
    const run = await harness.client.apply({}, { startedBy: { id: "alice" } });
    const report = await harness.client.applyReport(run);
    expect(report.plan.problems).toEqual([]);
    expect(report.results).toContainEqual(expect.objectContaining({ status: "done" }));
    expect(delivered.TEST_HOST_BOOTSTRAP).toBe(value);
    expect(delivered).not.toHaveProperty("TEST_LOCAL_ONLY");
    expect(delivered).not.toHaveProperty("TEST_NOT_DELIVERED");
    const ledger = JSON.stringify(await harness.client.ledger(run));
    expect(ledger).toContain('"$secret":"RELAY_TOKEN"');
    for (const history of [ledger, JSON.stringify(report), JSON.stringify(await harness.raw.listWorkflowSteps(run))])
      expect(history).not.toContain(value);
  });

  it("plans a binding given to the host with no value as a problem, leaving the host out before any vendor call", async () => {
    delete process.env.TEST_HOST_BOOTSTRAP;
    const problem = expect.objectContaining({
      file: "resources/sanoma/infra.ts",
      message: expect.stringMatching(
        /^host: RELAY_TOKEN \(`host: true`\) has no value where apply runs, .*: set TEST_HOST_BOOTSTRAP, /,
      ),
    });
    const run = await harness.client.apply({}, { startedBy: { id: "alice" } });
    const report = await harness.client.applyReport(run);
    expect(report.plan.problems).toEqual([problem]);
    expect(report.plan.steps.map((s) => s.id)).not.toContain("resources/sanoma/infra.ts#host");
    expect(report.results).toEqual([]);
    expect(delivered).toEqual({});
    // Drift reads the files as apply does: Hosting shows its check's problems.
    const drift = await harness.client.drift({ startedBy: { id: "alice" } });
    expect((await harness.client.driftReport(drift)).problems).toEqual([problem]);
  });
});
