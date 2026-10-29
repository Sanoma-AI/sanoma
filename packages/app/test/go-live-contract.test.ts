import { createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "@sanoma-ai/connector-github";
import { supabase } from "@sanoma-ai/connector-supabase";
import {
  type Connector,
  defineConnector,
  defineResource,
  type HostLifetime,
  resolveConfig,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppContext } from "../src/context.ts";
import { goLiveChoices, renderInfra, sourceKeyPair } from "../src/server/go-live.ts";

// Going live chooses the database, the host and the wakeup by their contracts, among the config's
// types: among those whose vendor is connected, Neon's database first, Cloudflare's host first,
// then Docker's, and the wakeup of the host's own vendor first. Over types of this file (the Neon and Cloudflare
// connectors are built elsewhere) and a client that answers only which secrets are stored.

const root = mkdtempSync(join(tmpdir(), "sanoma-go-live-contract-"));
writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "acme-ops", private: true })}\n`);
// The company's install of `sanoma`, whose version the runtime image of a host but Docker is.
mkdirSync(join(root, "node_modules", "sanoma"), { recursive: true });
writeFileSync(join(root, "node_modules", "sanoma", "package.json"), `${JSON.stringify({ version: "9.9.9" })}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const storeUrl = {
  storeUrl: {
    effect: "write",
    idempotent: true,
    input: z.object({ ref: z.string(), export: z.string() }),
    output: z.object({}),
    target: ({ ref }: { ref: string }) => ref,
  },
} as const;

const neonProject = defineResource({
  vendor: "neon",
  type: "project",
  title: "Neon project",
  identity: "name",
  schema: z.object({ name: z.string(), region: z.string(), size: z.string().optional(), id: z.string().optional() }),
  fields: { immutable: ["region"], vendorOwned: ["id"], writeOnly: [] },
  find: ({ name }) => name,
  writable: true,
  afterCreate: [{ op: "neon.project.storeUrl", input: ({ id, export: name }) => ({ ref: id, export: name }) }],
  database: {
    capabilities: { pauses: true, branch: true },
    inputs: { region: "region", size: "size" },
    storeUrl: "neon.project.storeUrl",
    regions: ["aws-us-east-2", "aws-eu-central-1"],
    outputs: (state) => ({ healthy: state.id != null }),
  },
});
const neonTypes = defineConnector("neon", { project: neonProject }, { title: "Neon", package: "@acme/neon" });
const neon = {
  ...neonTypes,
  project: { ...neonTypes.project, ...defineConnector("neon", { project: storeUrl }).project },
} as Connector<any, any>;

/** A host type of `vendor.type` with an `image`, as a container's. */
const hostOf = (vendor: string, type: string, lifetime: HostLifetime, publicUrl: boolean) =>
  defineResource({
    vendor,
    type,
    title: `${vendor} ${type}`,
    identity: "name",
    schema: z.object({
      name: z.string(),
      image: z.string(),
      source: z.string(),
      ref: z.string(),
      secrets: z.record(z.string(), z.string()).optional(),
      port: z.number(),
      revision: z.string().optional(),
      url: z.string().optional(),
    }),
    fields: {
      immutable: [],
      vendorOwned: ["url"],
      writeOnly: ["secrets"],
      references: { source: { type: "github.repository", by: ["http_clone_url"] } },
    },
    find: ({ name }) => name,
    writable: true,
    host: {
      capabilities: { lifetime, publicUrl, buildsFromGit: false, staticEgress: false },
      inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port" },
      revision: "revision",
      outputs: (state) => ({ url: String(state.url), healthy: true }),
    },
  });

const container = hostOf("cloudflare", "container", "stops-when-quiet", true);
const alarm = defineResource({
  vendor: "cloudflare",
  type: "alarm",
  title: "Alarm",
  schema: z.object({ host: z.string() }),
  fields: {
    immutable: [],
    vendorOwned: [],
    writeOnly: [],
    references: { host: { type: "cloudflare.container", by: ["url"] } },
  },
  writable: true,
  wakeup: {
    inputs: { host: "host" },
    register: "cloudflare.alarm.register",
    outputs: () => ({ healthy: true }),
  },
});
const cloudflareTypes = defineConnector("cloudflare", { container, alarm }, { package: "@acme/cloudflare" });
const register = defineConnector("cloudflare", {
  alarm: {
    register: {
      effect: "write",
      idempotent: true,
      input: z.object({ at: z.string() }),
      output: z.object({}),
    },
  },
});
const cloudflare = { ...cloudflareTypes, alarm: { ...cloudflareTypes.alarm, ...register.alarm } } as Connector<
  any,
  any
>;
const docker = defineConnector(
  "docker",
  { container: hostOf("docker", "container", "long-lived", false) },
  { package: "@acme/docker" },
);
const fly = defineConnector("fly", { app: hostOf("fly", "app", "stops-when-quiet", true) }, { package: "@acme/fly" });

/** A deploy key's public half, as `renderInfra` takes it. */
const DEPLOY_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC0deploykey";

/** Going live's context for a config, with `stored` the secrets the client says are stored. */
function contextOf(connectors: Connector<any, any>[], stored: Record<string, string> = {}): AppContext {
  const config: SanomaConfig = { workflows: [], connectors, root };
  return {
    resolved: resolveConfig(config),
    description: describeConfig(config),
    client: {
      secrets: async (names: readonly string[]) =>
        new Map(names.filter((n) => stored[n]).map((n) => [n, { value: stored[n]!, source: "stored" as const }])),
    } as unknown as AppContext["client"],
    place: "this-computer",
  } as AppContext;
}

const choices = { owner: "acme", name: "acme-ops", region: "aws-eu-central-1", size: "0.25", port: 8080 };
/** The choices for a database that takes no size, as the page sends them. */
const { size: _, ...unsized } = choices;
// Every config with a host type has the runtime's own wakeup, sanoma.wakeup, too.
const ALL = [github, supabase, neon, cloudflare, docker];
/** A wakeup service connected in /setup. */
const SERVICE = {
  SANOMA_WAKEUP_URL: "https://wakeup.example.test",
  SANOMA_WAKEUP_ACCOUNT_TOKEN: `swa_${"a".repeat(43)}`,
};

describe("going live by contract", () => {
  it("chooses Neon's database over Supabase's, with its regions and a size, and Docker's host before Cloudflare is connected", async () => {
    const app = contextOf(ALL);
    expect(await goLiveChoices(app)).toMatchObject({
      organizations: null,
      database: {
        type: "neon.project",
        title: "Neon project",
        regions: ["aws-us-east-2", "aws-eu-central-1"],
        size: true,
      },
      host: { type: "docker.container", publicUrl: false },
      missing: [],
      // Neon's key is not stored; Docker is no vendor /setup connects.
      connect: ["Neon"],
      errors: [],
    });
    const text = await renderInfra(app, choices, DEPLOY_KEY);
    expect(text).toContain(
      `export const store = neon.project({\n  name: "acme-ops",\n  region: "aws-eu-central-1",\n  size: "0.25",\n});\n`,
    );
    expect(text).toContain(`export const host = docker.container({\n  name: "acme-ops",\n  image: "sanoma-runtime",\n`);
    expect(text).not.toContain("supabase");
    expect(text).not.toContain("wakeup");
  });

  it("makes a deploy key OpenSSH reads: PKCS#1 PEM, and its public half in OpenSSH's format", async () => {
    const key = await sourceKeyPair();
    expect(key.privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    // `ssh-rsa`, then the strings `ssh-rsa`, e and n, each after its length.
    expect(key.publicKey).toMatch(/^ssh-rsa [A-Za-z0-9+/]+=*$/);
    const wire = Buffer.from(key.publicKey.slice("ssh-rsa ".length), "base64");
    const fields: Buffer[] = [];
    for (let at = 0; at < wire.length; at += 4 + wire.readUInt32BE(at)) {
      fields.push(wire.subarray(at + 4, at + 4 + wire.readUInt32BE(at)));
    }
    const [kind, e, n] = fields;
    expect(kind!.toString()).toBe("ssh-rsa");
    const jwk = createPublicKey(key.privateKey).export({ format: "jwk" });
    // An mpint with its top bit set leads with a zero byte, which a JWK's integer has not.
    expect(n![0]).toBe(0);
    expect({ e: e!.toString("base64url"), n: n!.subarray(1).toString("base64url") }).toEqual({ e: jwk.e, n: jwk.n });
  });

  it("declares the repository's read-only deploy key, whose private half the host is given to clone with", async () => {
    const text = await renderInfra(contextOf(ALL), choices, DEPLOY_KEY);
    expect(text).toContain(
      `export const deployKey = github.repository_deploy_key({\n  repository: repo,\n  title: "Sanoma host",\n  key: "${DEPLOY_KEY}",\n  read_only: true,\n});\n`,
    );
    expect(text).toContain(`    SANOMA_SOURCE_KEY: secret("SANOMA_SOURCE_KEY"),\n`);
    expect(text).toContain("export default [repo, deployKey, store, host];");
  });

  it("leaves out the size when none is chosen", async () => {
    expect(await renderInfra(contextOf(ALL), unsized, DEPLOY_KEY)).toContain(
      `export const store = neon.project({\n  name: "acme-ops",\n  region: "aws-eu-central-1",\n});\n`,
    );
  });

  it("runs on Cloudflare once it is connected, the published runtime image, woken by its own alarm first", async () => {
    const app = contextOf(ALL, {
      CLOUDFLARE_API_TOKEN: "cf",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      ...SERVICE,
    });
    expect((await goLiveChoices(app)).host).toEqual({
      type: "cloudflare.container",
      title: "cloudflare container",
      publicUrl: true,
    });
    const text = await renderInfra(app, choices, DEPLOY_KEY);
    expect(text).toContain(
      `export const host = cloudflare.container({\n  name: "acme-ops",\n  image: "ghcr.io/sanoma-ai/runtime:9.9.9",\n`,
    );
    // A wakeup service wakes a Cloudflare container too: the host's own vendor's wakeup comes first.
    expect(text).toContain(`export const wakeup = cloudflare.alarm({\n  host: host,\n});\n`);
    expect(text).toContain(`    SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN"),\n  },\n`);
    expect(text).not.toContain("SANOMA_WAKEUP_URL");
    expect(text).not.toContain("sanoma.wakeup");
  });

  it("stays on Docker with Cloudflare's token but not its account, and refuses a host or a database the page did not show", async () => {
    const half = contextOf(ALL, { CLOUDFLARE_API_TOKEN: "cf" });
    expect((await goLiveChoices(half)).host?.type).toBe("docker.container");
    const connected = contextOf(ALL, { CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" });
    await expect(renderInfra(connected, { ...choices, host: "docker.container" }, DEPLOY_KEY)).rejects.toMatchObject({
      status: 409,
      message: "Going live now runs the company on cloudflare.container, not docker.container: reload the page",
    });
    const supabaseConnected = contextOf(ALL, { SUPABASE_ACCESS_TOKEN: "sb" });
    await expect(
      renderInfra(supabaseConnected, { ...choices, database: "neon.project" }, DEPLOY_KEY),
    ).rejects.toMatchObject({
      status: 409,
      message: "Going live now keeps the company's records in supabase.project, not neon.project: reload the page",
    });
  });

  it("chooses among connected vendors: Supabase's database without Neon's key, Fly's host without Cloudflare's", async () => {
    const app = contextOf([github, supabase, neon, cloudflare, fly], { SUPABASE_ACCESS_TOKEN: "sb" });
    const text = await renderInfra(app, { ...unsized, region: "eu-west-1", organization: "org" }, DEPLOY_KEY);
    expect(text).toContain("export const store = supabase.project({");
    expect(text).toContain("export const host = fly.app({");
  });

  it("refuses a region the database does not list, and a size it does not take", async () => {
    await expect(renderInfra(contextOf(ALL), { ...choices, region: "mars" }, DEPLOY_KEY)).rejects.toMatchObject({
      status: 400,
      body: { issues: [{ path: ["region"] }] },
    });
    const supabaseOnly = contextOf([github, supabase, docker]);
    await expect(
      renderInfra(supabaseOnly, { ...choices, region: "eu-west-1", organization: "org" }, DEPLOY_KEY),
    ).rejects.toMatchObject({ status: 400, body: { issues: [{ path: ["size"] }] } });
  });

  it("writes an input at a dotted path as nested fields", async () => {
    const nested = defineResource({
      vendor: "nested",
      type: "db",
      title: "Nested database",
      schema: z.object({ name: z.string(), settings: z.object({ region: z.string() }) }),
      fields: { immutable: [], vendorOwned: [], writeOnly: [] },
      writable: true,
      afterCreate: [{ op: "nested.db.storeUrl", input: ({ id, export: name }) => ({ ref: id, export: name }) }],
      database: {
        capabilities: { pauses: false, branch: false },
        inputs: { region: "settings.region" },
        storeUrl: "nested.db.storeUrl",
        outputs: () => ({ healthy: true }),
      },
    });
    const types = defineConnector("nested", { db: nested }, { package: "@acme/nested" });
    const connector = { ...types, db: { ...types.db, ...defineConnector("nested", { db: storeUrl }).db } } as Connector<
      any,
      any
    >;
    const text = await renderInfra(contextOf([github, connector, docker]), unsized, DEPLOY_KEY);
    expect(text).toContain(
      `export const store = nested.db({\n  name: "acme-ops",\n  settings: { region: "aws-eu-central-1" },\n});\n`,
    );
  });

  it("says why no wakeup is declared when none connected wakes the host", async () => {
    const app = contextOf([github, neon, fly], SERVICE);
    expect((await goLiveChoices(app)).errors).toEqual([
      "No connected wakeup wakes a fly.app (Wakeup (sanoma.wakeup) wakes cloudflare.container, docker.container, testhost.app): going live declares none, and the host stays up",
    ]);
    expect(await renderInfra(app, choices, DEPLOY_KEY)).not.toContain("wakeup");
  });

  it("reports a missing database type, and a Supabase project without an organization", async () => {
    expect((await goLiveChoices(contextOf([github, docker]))).missing).toEqual(["a database type"]);
    // A GitHub connector of a release before deploy keys.
    const earlier = contextOf([github, supabase, docker]);
    (earlier.resolved.types as Map<string, unknown>).delete("github.repository_deploy_key");
    expect((await goLiveChoices(earlier)).missing).toEqual(["github.repository_deploy_key"]);
    await expect(renderInfra(contextOf([github, docker]), unsized, DEPLOY_KEY)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      renderInfra(contextOf([github, supabase, docker]), { ...unsized, region: "eu-west-1" }, DEPLOY_KEY),
    ).rejects.toMatchObject({ status: 400, body: { issues: [{ path: ["organization"] }] } });
  });
});
