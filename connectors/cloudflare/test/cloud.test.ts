import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neon } from "@sanoma-ai/connector-neon";
import { fakeNeon } from "@sanoma-ai/connector-neon/fake";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { defineWorkflow, type LedgerRecord, memoryLedger, resolveConfig, withSetup } from "@sanoma-ai/workflows";
import { writeLockfile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeCloudflare } from "../src/fake.ts";
import { cloudflare } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. A company workflow that makes, changes and deletes the vendor
// objects no data file declares, as the control plane's workflows do per company, with the
// resource types' own change operations, over the Neon and Cloudflare fakes; and the refusal of
// the same operations aimed at an object the data files declare, which only apply changes.

const IMAGE = "ghcr.io/sanoma-ai/runtime:0.7.0";
const SOURCE = "file:///unused.git";

const root = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-cloud-"));
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cloudflare-cloud", type: "module" }));
mkdirSync(join(root, "resources"));
// The company's own host, bound, and its staging host, declared and not made yet.
writeFileSync(
  join(root, "resources", "hosts.ts"),
  `import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";\n\n` +
    `const common = { image: "${IMAGE}", source: "${SOURCE}", ref: "main", port: 3000 };\n` +
    `export const ops = cloudflare.container({ name: "ops", ...common });\n` +
    `export const staging = cloudflare.container({ name: "staging", ...common });\n\n` +
    `export default [ops, staging];\n`,
);
writeLockfile(root, { "resources/hosts.ts#ops": { type: "cloudflare.container", id: "ops" } });

const cf = fakeCloudflare();
const nf = fakeNeon();
const cfOps = withSetup(cloudflare, { driver: () => cf.driver });
// Without its named authentication: the fake needs no account, so a call selects no connection.
const neonOps = withSetup(neon, { driver: () => nf.driver, authentication: undefined });

/** A company's host, as the control plane makes it: each secret under a name of the company's own. */
const hostOf = (company: string, revision: string) => {
  const key = `CLOUD_${company.toUpperCase()}`;
  return {
    name: `cloud-${company}`,
    image: IMAGE,
    source: SOURCE,
    ref: "main",
    revision,
    port: 3000,
    secrets: {
      SANOMA_DATABASE_URL: secret(`SANOMA_DATABASE_URL_${key}`),
      SANOMA_SECRETS_KEY: secret(`${key}_SECRETS_KEY`, { generate: true }),
      SANOMA_WAKEUP_TOKEN: secret(`${key}_WAKEUP_TOKEN`, { generate: true }),
    },
  };
};

const signup = defineWorkflow({
  name: "cloud-signup",
  trigger: "manual",
  input: z.object({ company: z.string() }),
  uses: [neon.project.create, neon.project.storeUrl, cloudflare.container.create, cloudflare.alarm.create],
  run: async (ctx, { company }) => {
    const key = `CLOUD_${company.toUpperCase()}`;
    const project = await ctx.neon.project.create({ desired: { name: `cloud-${company}`, region: "aws-us-east-1" } });
    await ctx.neon.project.storeUrl({ id: project.id, export: key });
    const host = await ctx.cloudflare.container.create({ desired: hostOf(company, "r1") });
    const alarm = await ctx.cloudflare.alarm.create({
      desired: { host: host.state.url, token: secret(`${key}_WAKEUP_TOKEN`) },
    });
    return { project: project.id, container: host.id, alarm: { id: alarm.id, state: alarm.state } };
  },
});

const deploy = defineWorkflow({
  name: "cloud-deploy",
  trigger: "manual",
  input: z.object({ company: z.string(), container: z.string(), revision: z.string() }),
  uses: [cloudflare.container.update],
  run: async (ctx, { company, container, revision }) =>
    (await ctx.cloudflare.container.update({ id: container, desired: hostOf(company, revision) })).state,
});

const close = defineWorkflow({
  name: "cloud-close",
  trigger: "manual",
  input: z.object({
    project: z.string(),
    container: z.string(),
    alarm: z.object({ id: z.string(), state: z.record(z.string(), z.unknown()) }),
  }),
  uses: [cloudflare.alarm.delete, cloudflare.container.delete, neon.project.delete],
  run: async (ctx, { project, container, alarm }) => {
    await ctx.cloudflare.alarm.delete(alarm);
    await ctx.cloudflare.container.delete({ id: container });
    await ctx.neon.project.delete({ id: project });
    return "closed";
  },
});

/** A workflow that aims a container's change operation at the company's name it is given. */
const aim = defineWorkflow({
  name: "aim",
  trigger: "manual",
  input: z.object({ op: z.enum(["create", "update", "delete"]), name: z.string() }),
  uses: [cloudflare.container.create, cloudflare.container.update, cloudflare.container.delete],
  run: async (ctx, { op, name }) => {
    const desired = { name, image: IMAGE, source: SOURCE, ref: "main", revision: "r1", port: 3000 };
    let id: string;
    if (op === "create") id = (await ctx.cloudflare.container.create({ desired })).id;
    else if (op === "update") id = (await ctx.cloudflare.container.update({ id: name, desired })).id;
    else id = (await ctx.cloudflare.container.delete({ id: name })).id;
    return id;
  },
});

const calls = (records: LedgerRecord[]) =>
  records.flatMap((r) => (r.type === "op.called" && !r.error ? [[r.op, r.effect] as const] : []));

describe("a workflow changes the vendor objects no data file declares", () => {
  const app = useTestApp(
    {
      workflows: [signup, deploy, close, aim],
      connectors: [cfOps, neonOps],
      root,
      ledger: memoryLedger(),
      // A store namespace of each run's own: every run encrypts with a key of its own.
      secrets: { namespace: `cloud-${Date.now()}` },
    },
    { databaseUrl: testDatabaseUrl("cloudflare_cloud") },
  );
  const by = { startedBy: { id: "ops" } };

  afterAll(async () => {
    await cf.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("names a resource type's change operations in its uses; a direct call of one is still refused", async () => {
    const all = defineWorkflow({
      name: "all",
      trigger: "manual",
      input: z.object({}),
      uses: [
        cloudflare.container.create,
        neon.project.create,
        cloudflare.alarm.create,
        cloudflare.container.update,
        cloudflare.container.delete,
      ],
      run: async () => 1,
    });
    expect(resolveConfig({ ...app.config, workflows: [all] }).workflows.has("all")).toBe(true);
    await expect(
      app.client.call("cloudflare.container.create", { desired: hostOf("direct", "r1") }, { actor: "ops" }),
    ).rejects.toThrow("cloudflare.container.create cannot be called directly: it is a workflow's to call");
    expect(cf.state.scripts).toEqual({});
  });

  it("is refused an object the data files declare: an id the lockfile binds, a name a data file declares", async () => {
    const refused = async (op: "create" | "update" | "delete", name: string, key: string) => {
      const runId = await app.client.start(aim, { op, name }, by);
      await expect(app.client.result(runId)).rejects.toThrow(
        `cloudflare.container.${op} changes resources/hosts.ts#${key}, a declared resource, which only apply does: change the data file instead`,
      );
      expect(calls(await app.client.ledger(runId))).toEqual([]);
    };
    await refused("update", "ops", "ops");
    await refused("delete", "ops", "ops");
    await refused("create", "staging", "staging");
    await refused("create", "ops", "ops");
    expect(cf.state.scripts).toEqual({});
    // A name nothing declares is the workflow's own.
    const made = await app.client.start(aim, { op: "create", name: "other" }, by);
    expect(await app.client.result(made)).toBe("other");
    const gone = await app.client.start(aim, { op: "delete", name: "other" }, by);
    expect(await app.client.result(gone)).toBe("other");
    expect(cf.state.scripts).toEqual({});
  });

  it("makes a company's project, host and alarm under its own secret names, deploys a revision, and deletes them", async () => {
    const signed = await app.client.start(signup, { company: "acme" }, by);
    const made = (await app.client.result(signed)) as {
      project: string;
      container: string;
      alarm: { id: string; state: Record<string, unknown> };
    };
    expect(made.container).toBe("cloud-acme");
    expect(made.alarm.state).toMatchObject({ healthy: true, token: "CLOUD_ACME_WAKEUP_TOKEN" });
    expect(Object.keys(nf.state.projects)).toEqual([made.project]);
    expect(Object.keys(cf.state.scripts)).toEqual(["sanoma-cloud-acme"]);

    // The store holds the company's secrets under its own names, and none under the instance's.
    const names = ["SANOMA_DATABASE_URL_CLOUD_ACME", "CLOUD_ACME_SECRETS_KEY", "CLOUD_ACME_WAKEUP_TOKEN"];
    const stored = await app.client.secrets([...names, "SANOMA_WAKEUP_TOKEN"]);
    expect([...stored.keys()].toSorted()).toEqual(names.toSorted());
    // The host's Worker holds them under the names the runtime reads, never their values in its state.
    expect(cf.state.scripts["sanoma-cloud-acme"]!.bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "SANOMA_DATABASE_URL" },
        { type: "secret_text", name: "SANOMA_SECRETS_KEY" },
        { type: "secret_text", name: "SANOMA_WAKEUP_TOKEN" },
      ]),
    );

    const deployed = await app.client.start(deploy, { company: "acme", container: made.container, revision: "r2" }, by);
    expect(await app.client.result(deployed)).toMatchObject({ name: "cloud-acme", revision: "r2" });
    expect(cf.state.scripts["sanoma-cloud-acme"]!.bindings).toContainEqual({
      type: "plain_text",
      name: "SANOMA_REVISION",
      text: "r2",
    });

    const closed = await app.client.start(close, made, by);
    expect(await app.client.result(closed)).toBe("closed");
    expect(cf.state.scripts).toEqual({});
    expect(nf.state.projects).toEqual({});

    // The ledger records each as the ordinary call it is, a secret by its marker, never its value.
    expect(calls(await app.client.ledger(signed))).toEqual([
      ["neon.project.create", "write"],
      ["neon.project.storeUrl", "write"],
      ["cloudflare.container.create", "write"],
      ["cloudflare.alarm.create", "write"],
    ]);
    expect(calls(await app.client.ledger(deployed))).toEqual([["cloudflare.container.update", "write"]]);
    expect(calls(await app.client.ledger(closed))).toEqual([
      ["cloudflare.alarm.delete", "write"],
      ["cloudflare.container.delete", "write"],
      ["neon.project.delete", "write"],
    ]);
    const ledger = JSON.stringify(await app.client.ledger(signed));
    expect(ledger).toContain('"$secret":"CLOUD_ACME_SECRETS_KEY"');
    for (const { value } of stored.values()) expect(ledger).not.toContain(value);
  });
});
