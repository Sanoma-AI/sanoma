import { fakeHost, fakeHostType, testRepository } from "@sanoma-ai/testing/host";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import { tree } from "./tree.ts";
import { secret } from "../src/secret.ts";
import {
  defineConnector,
  defineResource,
  DRIFT_WORKFLOW,
  type HostSpec,
  resolveConfig,
  resolveRevision,
  SOURCE_RESOLVE,
} from "../src/index.ts";

const schema = z.object({
  name: z.string(),
  repo: z.object({ url: z.string(), branch: z.string() }),
  env: z.record(z.string(), z.string()).optional(),
  port: z.number().optional(),
  commit: z.string().optional(),
  sites: z.record(z.string(), z.string()).optional(),
});
const host: HostSpec = {
  capabilities: { lifetime: "long-lived", publicUrl: true, buildsFromGit: true, staticEgress: false },
  inputs: { source: "repo.url", ref: "repo.branch", secrets: "env", port: "port" },
  revision: "commit",
  outputs: (state) => ({ url: String(state.url), healthy: true }),
};
const fields = { immutable: [], vendorOwned: [], writeOnly: ["env"] };
const hostOf = (overrides: Partial<HostSpec> & { writeOnly?: string[]; writable?: boolean }) =>
  defineResource({
    vendor: "acme",
    type: "service",
    title: "Service",
    schema,
    fields: { ...fields, writeOnly: overrides.writeOnly ?? fields.writeOnly },
    writable: overrides.writable ?? true,
    host: { ...host, ...overrides },
  });

describe("a host type", () => {
  it("meets the contract by dotted paths into its fields, and is stateless", () => {
    const service = hostOf({});
    expect(service.host).toMatchObject({ inputs: host.inputs, revision: "commit" });
    expect(service.stateless).toBe(true);
    expect(fakeHostType.stateless).toBe(true);
    const plain = defineResource({ vendor: "acme", type: "db", title: "Database", schema, fields });
    expect([plain.stateless, plain.host]).toEqual([false, undefined]);
  });

  it.each([
    ["one apply cannot change", { writable: false }, /it must be writable/],
    [
      "an input that names no field",
      { inputs: { ...host.inputs, ref: "repo.tag" } },
      /ref names no field \(repo\.tag\)/,
    ],
    [
      "domains that name no field",
      { inputs: { ...host.inputs, domains: "domains" } },
      /domains names no field \(domains\)/,
    ],
    ["secrets that are not write-only", { writeOnly: [] }, /inputs\.secrets must be a write-only field/],
    ["a revision that is write-only", { writeOnly: ["env", "commit"] }, /revision must not be write-only/],
    [
      "a lifetime it does not know",
      { capabilities: { ...host.capabilities, lifetime: "forever" as never } },
      /lifetime/,
    ],
  ])("is refused with %s", (_, overrides, message) => {
    expect(() => hostOf(overrides)).toThrow(message);
  });

  it("may take a public site's domains in a field of its own", () => {
    expect(hostOf({ inputs: { ...host.inputs, domains: "sites" } }).host?.inputs.domains).toBe("sites");
  });

  it("is described with a problem at its declaration for each of its domains that names no public site", () => {
    const service = hostOf({ inputs: { ...host.inputs, domains: "sites" } });
    const acme = defineConnector("acme", { service }, { title: "Acme", package: "@acme/connector" });
    const route = 'import { createFileRoute } from "@tanstack/react-router";\n';
    const root = tree("domains", {
      "resources/infra.ts": [
        'import { acme } from "@acme/connector/resources";',
        "",
        "export const host = acme.service({",
        '  name: "app",',
        '  repo: { url: "https://example.com/a.git", branch: "main" },',
        '  sites: { www: "sanoma.example", cms: "cms.sanoma.example", gone: "gone.example" },',
        "});",
        "",
      ].join("\n"),
      "sites/www/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true });\n',
      "sites/www/routes/index.tsx": route,
      "sites/cms/routes/index.tsx": route,
    });
    const { problems, resources } = describeConfig({ workflows: [], connectors: [acme], root });
    expect(resources.map((r) => r.id)).toEqual(["resources/infra.ts#host"]);
    expect(problems).toEqual(
      ["cms", "gone"].map((name) => ({
        file: "resources/infra.ts",
        line: 3,
        column: 1,
        message: `domains names "${name}", which is not a public site (defineSite({ public: true }))`,
      })),
    );
    // Without the names that are not, none.
    const fine = tree("domains-fine", {
      "resources/infra.ts": [
        'import { acme } from "@acme/connector/resources";',
        'export const host = acme.service({ name: "app", repo: { url: "u", branch: "main" }, sites: { www: "sanoma.example" } });',
        "",
      ].join("\n"),
      "sites/www/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true });\n',
      "sites/www/routes/index.tsx": route,
    });
    expect(describeConfig({ workflows: [], connectors: [acme], root: fine }).problems).toEqual([]);
  });

  it("is described with a problem at its declaration for each domain it gives more than one site", () => {
    const service = hostOf({ inputs: { ...host.inputs, domains: "sites" } });
    const acme = defineConnector("acme", { service }, { title: "Acme", package: "@acme/connector" });
    const site = 'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true });\n';
    const route = 'import { createFileRoute } from "@tanstack/react-router";\n';
    const root = tree("domains-twice", {
      "resources/infra.ts": [
        'import { acme } from "@acme/connector/resources";',
        "",
        "export const host = acme.service({",
        '  name: "app",',
        '  repo: { url: "https://example.com/a.git", branch: "main" },',
        '  sites: { www: "sanoma.example", docs: "sanoma.example", blog: "blog.example" },',
        "});",
        "",
      ].join("\n"),
      ...Object.fromEntries(
        ["www", "docs", "blog"].flatMap((name) => [
          [`sites/${name}/site.ts`, site],
          [`sites/${name}/routes/index.tsx`, route],
        ]),
      ),
    });
    expect(describeConfig({ workflows: [], connectors: [acme], root }).problems).toEqual([
      { file: "resources/infra.ts", line: 3, column: 1, message: "sanoma.example is the domain of both www and docs" },
    ]);
  });

  it("takes sanoma's own secrets in its secrets map, and no other type does", () => {
    const service = hostOf({});
    const env = { SANOMA_DATABASE_URL: secret("SANOMA_DATABASE_URL_STORE"), TOKEN: secret("TOKEN") };
    const declared = { name: "app", repo: { url: "https://example.com/a.git", branch: "main" }, env };
    expect(service(declared).desired.env).toEqual({
      SANOMA_DATABASE_URL: { $secret: "SANOMA_DATABASE_URL_STORE" },
      TOKEN: { $secret: "TOKEN" },
    });
    const plain = defineResource({ vendor: "acme", type: "db", title: "Database", schema, fields });
    expect(() => plain({ ...declared, env: { KEY: secret("SANOMA_SECRETS_KEY") } })).toThrow(
      "acme.db: env.KEY names SANOMA_SECRETS_KEY, one of sanoma's own: only a host's secrets may",
    );
  });

  it("refuses a declaration that gives its revision: apply fills it from the ref", () => {
    const service = hostOf({});
    const declared = { name: "app", repo: { url: "https://example.com/a.git", branch: "main" } };
    expect(service(declared).desired).toEqual(declared);
    expect(() => service({ ...declared, commit: "abc" })).toThrow(
      "acme.service: leave out commit: apply sets it from repo.branch",
    );
  });
});

describe("sanoma.source.resolve", () => {
  const repo = testRepository();
  afterAll(() => repo.remove());

  it("resolves a branch, an annotated tag, HEAD and a commit id to the commit each names now", async () => {
    const first = await repo.commit();
    repo.git("tag", "-a", "v1", "-m", "One");
    repo.git("push", "-q", repo.url, "refs/tags/v1");
    const second = await repo.commit();
    expect(await resolveRevision(repo.url, "main")).toBe(second);
    expect(await resolveRevision(repo.url, "v1")).toBe(first);
    expect(await resolveRevision(repo.url, "HEAD")).toBe(second);
    expect(await resolveRevision(repo.url, "refs/heads/main")).toBe(second);
    expect(await resolveRevision(repo.url, first)).toBe(first);
  });

  it("refuses a ref the repository does not have, for good, and a repository it cannot read, to retry", async () => {
    await expect(resolveRevision(repo.url, "nope")).rejects.toMatchObject({
      vendorCode: "no_such_ref",
      retryable: false,
    });
    await expect(resolveRevision(`${repo.url}-missing`, "main")).rejects.toMatchObject({
      code: "driver_failed",
      retryable: true,
    });
  });

  it("is registered, with its driver, for a config that declares a host type, and drift uses it", () => {
    const { connector } = fakeHost(async () => ({ url: "http://127.0.0.1:1", stop: async () => undefined }));
    const hosted = resolveConfig({ workflows: [], connectors: [connector] });
    expect(hosted.ops.get(SOURCE_RESOLVE)).toMatchObject({ effect: "read", idempotent: true });
    expect(hosted.drivers.has(SOURCE_RESOLVE)).toBe(true);
    expect(
      hosted.workflows
        .get(DRIFT_WORKFLOW)
        ?.uses.map((op: unknown) => (typeof op === "string" ? op : (op as { id: string }).id)),
    ).toEqual(["testhost.app.import", SOURCE_RESOLVE]);
    // Not for a config without one.
    const db = defineResource({ vendor: "acme", type: "db", title: "Database", schema, fields });
    const plain = resolveConfig({
      workflows: [],
      connectors: [defineConnector("acme", { db }, { package: "@acme/connector" })],
    });
    expect(plain.ops.has(SOURCE_RESOLVE)).toBe(false);
  });
});
