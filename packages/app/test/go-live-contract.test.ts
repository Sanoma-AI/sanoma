import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { github } from "@sanoma-ai/connector-github";
import { sanomaOps } from "@sanoma-ai/connector-sanoma-ops";
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
import { goLiveChoices, renderInfra } from "../src/server/go-live.ts";

// Going live chooses the database, the host and the wakeup by their contracts, among the config's
// types: Neon's database first, Cloudflare's host once it is connected, else Docker's, and the
// wakeup of the host's own vendor first. Over types of this file (the Neon and Cloudflare
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
      input: z.object({ at: z.string(), generation: z.number() }),
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
const fly = defineConnector("fly", { app: hostOf("fly", "app", "stops-on-exit", true) }, { package: "@acme/fly" });

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

const choices = { name: "acme-ops", region: "aws-eu-central-1", size: "0.25", port: 8080 };
const ALL = [github, supabase, neon, cloudflare, docker, sanomaOps];

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
      errors: [],
    });
    const text = await renderInfra(app, choices);
    expect(text).toContain(
      `export const store = neon.project({\n  name: "acme-ops",\n  region: "aws-eu-central-1",\n  size: "0.25",\n});\n`,
    );
    expect(text).toContain(`export const host = docker.container({\n  name: "acme-ops",\n  image: "sanoma-runtime",\n`);
    expect(text).not.toContain("supabase");
    expect(text).not.toContain("wakeup");
  });

  it("leaves out the size when none is chosen", async () => {
    const { size: _, ...unsized } = choices;
    expect(await renderInfra(contextOf(ALL), unsized)).toContain(
      `export const store = neon.project({\n  name: "acme-ops",\n  region: "aws-eu-central-1",\n});\n`,
    );
  });

  it("runs on Cloudflare once it is connected, the published runtime image, woken by its own alarm first", async () => {
    const app = contextOf(ALL, { CLOUDFLARE_API_TOKEN: "cf", SANOMA_OPS_TOKEN: `swa_${"a".repeat(43)}` });
    expect((await goLiveChoices(app)).host).toEqual({
      type: "cloudflare.container",
      title: "cloudflare container",
      publicUrl: true,
    });
    const text = await renderInfra(app, choices);
    expect(text).toContain(
      `export const host = cloudflare.container({\n  name: "acme-ops",\n  image: "docker.io/sanomaai/runtime:9.9.9",\n`,
    );
    // sanoma-ops wakes a Cloudflare container too: the host's own vendor's wakeup comes first.
    expect(text).toContain(`export const wakeup = cloudflare.alarm({\n  host: host,\n});\n`);
    expect(text).toContain(`    SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN"),\n  },\n`);
    expect(text).not.toContain("SANOMA_OPS_URL");
    expect(text).not.toContain("sanomaOps");
  });

  it("says why no wakeup is declared when none connected wakes the host", async () => {
    const app = contextOf([github, neon, fly, sanomaOps], { SANOMA_OPS_TOKEN: `swa_${"a".repeat(43)}` });
    expect((await goLiveChoices(app)).errors).toEqual([
      "No connected wakeup wakes a fly.app (Wakeup (sanomaOps.wakeup) wakes cloudflare.container, docker.container, testhost.app): going live declares none, and the host stays up",
    ]);
    expect(await renderInfra(app, choices)).not.toContain("wakeup");
  });

  it("reports a missing database type, and a Supabase project without an organization", async () => {
    expect((await goLiveChoices(contextOf([github, docker]))).missing).toEqual(["a database type"]);
    await expect(renderInfra(contextOf([github, docker]), choices)).rejects.toMatchObject({ status: 409 });
    await expect(
      renderInfra(contextOf([github, supabase, docker]), { ...choices, region: "eu-west-1" }),
    ).rejects.toMatchObject({ status: 400, body: { issues: [{ path: ["organization"] }] } });
  });
});
