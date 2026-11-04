import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import { cloneUrl, deriveHosts, githubRepository, HOST_SIGNING_KEY, type HostFacts } from "../src/host-derive.ts";
import { detaching, sourceKeyId, UNNAMED } from "../src/host.ts";
import { loadDataFiles } from "../src/resources.ts";
import { isSecret } from "../src/secret.ts";
import { defineConnector, defineResource, type HostSpec, type Resource, RUNTIME_IMAGE } from "../src/index.ts";
import { tree } from "./tree.ts";

// A host that derives (`HostSpec.derives`): its data file says its decisions, and apply fills the
// rest before it plans (`deriveHosts`), the deploy key it clones with among them.

const hostSchema = z.object({
  name: z.string().nullish(),
  image: z.string().nullish(),
  source: z.string().nullish(),
  ref: z.string().nullish(),
  revision: z.string().nullish(),
  database: z.string().nullish(),
  secrets: z.record(z.string(), z.string()).nullish(),
  domains: z.record(z.string(), z.string()).nullish(),
  hostname: z.string().nullish(),
});
const spec: HostSpec = {
  capabilities: { lifetime: "stops-when-quiet", publicUrl: true, buildsFromGit: false, staticEgress: false },
  derives: true,
  inputs: {
    name: "name",
    source: "source",
    ref: "ref",
    image: "image",
    database: "database",
    secrets: "secrets",
    domains: "domains",
    hostname: "hostname",
  },
  revision: "revision",
  outputs: (state) => ({ url: String(state.url ?? ""), healthy: true }),
};
const service = defineResource({
  vendor: "acme",
  type: "service",
  title: "Service",
  identity: "name",
  schema: hostSchema,
  formerly: ["acme.container"],
  fields: {
    immutable: ["name"],
    vendorOwned: [],
    writeOnly: ["secrets", "database"],
    references: {
      source: { type: "github.repository", by: ["http_clone_url"] },
      database: { type: "acme.db" },
    },
  },
  find: ({ name }) => name ?? UNNAMED,
  writable: true,
  host: spec,
});
const db = defineResource({
  vendor: "acme",
  type: "db",
  title: "Database",
  identity: "name",
  schema: z.object({ name: z.string() }),
  fields: { immutable: [], vendorOwned: [], writeOnly: [] },
  find: ({ name }) => name,
});
const repository = defineResource({
  vendor: "github",
  type: "repository",
  title: "Repository",
  schema: z.object({ owner: z.string(), name: z.string(), http_clone_url: z.string().nullish() }),
  fields: { immutable: [], vendorOwned: ["http_clone_url"], writeOnly: [] },
  find: ({ owner, name }) => `${owner}/${name}`,
});
const deployKey = defineResource({
  vendor: "github",
  type: "repository_deploy_key",
  title: "Deploy key",
  schema: z.object({ repository: z.string(), title: z.string(), key: z.string(), read_only: z.boolean() }),
  fields: {
    immutable: ["key"],
    vendorOwned: [],
    writeOnly: [],
    references: { repository: { type: "github.repository" } },
  },
  find: (declared) => `${declared.repository}:${declared.key}`,
});
const acme = defineConnector("acme", { service, db }, { title: "Acme", package: "@acme/connector" });
const github = defineConnector(
  "github",
  { repository, repository_deploy_key: deployKey },
  { title: "GitHub", package: "@acme/github" },
);
const types = new Map<string, Resource>(
  [service, db, repository, deployKey].map((type) => [`${type.vendor}.${type.type}`, type as unknown as Resource]),
);

const facts = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  version: "1.2.3",
  origin: "https://github.com/acme/company.git",
  domains: { www: "www.acme.example" },
  builtInStore: true,
  carried: new Map([
    ["acme", ["ACME_TOKEN"]],
    ["github", ["GITHUB_TOKEN"]],
  ]),
  githubApp: ["SANOMA_GITHUB_APP_ID"],
  sourceKey: "ssh-rsa AAAA public-half",
  ...overrides,
});

const INFRA = [
  'import { acme } from "@acme/connector/resources";',
  'import { github } from "@acme/github/resources";',
  "",
  'export const repo = github.repository({ owner: "acme", name: "company" });',
  'export const store = acme.db({ name: "company" });',
  'export const host = acme.service({ name: "company", hostname: "internal.acme.example", database: store });',
  "",
].join("\n");

const load = (files: Record<string, string>) => {
  const root = tree("host-derive", files);
  return { root, ...loadDataFiles(root, [acme, github], types) };
};

describe("a host that derives", () => {
  it("is declared by its decisions, and refused with its secrets or its domains", () => {
    expect(() => service({ name: "a", secrets: { KEY: "value" } })).toThrow(/leave out secrets: apply gives the host/);
    expect(() => service({ name: "a", domains: { www: "www.a.example" } })).toThrow(
      /leave out domains: a public site's domain is declared on the site/,
    );
    expect(service({ name: "a", hostname: "internal.a.example" })).toBeTruthy();
  });

  it("is given the installed sanoma's image, the declared repository, the sites' domains, its secrets as markers and a deploy key", () => {
    const { resources, bindings, problems } = load({ "resources/sanoma/infra.ts": INFRA });
    expect(problems).toEqual([]);
    expect(deriveHosts(resources, types, bindings, facts())).toEqual([]);
    const host = resources.find((r) => r.id === "resources/sanoma/infra.ts#host")!;
    expect(host.desired).toMatchObject({
      image: `${RUNTIME_IMAGE}:1.2.3`,
      source: "acme/company",
      domains: { www: "www.acme.example" },
    });
    expect(host.desired.ref).toBeUndefined();
    expect(host.refs.source).toBe("resources/sanoma/infra.ts#repo");
    const secrets = host.desired.secrets as Record<string, unknown>;
    expect(Object.values(secrets).every(isSecret)).toBe(true);
    expect(Object.keys(secrets).toSorted()).toEqual(
      [
        "ACME_TOKEN",
        "GITHUB_TOKEN",
        "SANOMA_DATABASE_URL",
        "SANOMA_GITHUB_APP_ID",
        "SANOMA_SECRETS_KEY",
        "SANOMA_SIGNING_KEY",
        "SANOMA_SOURCE_KEY",
      ].toSorted(),
    );
    expect(secrets.SANOMA_DATABASE_URL).toEqual({ $secret: "SANOMA_DATABASE_URL_STORE" });
    // The deploy key, before the host, so apply makes it first.
    const keyId = sourceKeyId(host.id);
    expect(resources.map((r) => r.id)).toEqual([
      "resources/sanoma/infra.ts#repo",
      "resources/sanoma/infra.ts#store",
      keyId,
      host.id,
    ]);
    expect(resources.find((r) => r.id === keyId)).toMatchObject({
      vendor: "github",
      type: "repository_deploy_key",
      desired: { repository: "acme/company", title: "Sanoma host", key: "ssh-rsa AAAA public-half", read_only: true },
      refs: { repository: "resources/sanoma/infra.ts#repo" },
    });
  });

  it("runs from the app's origin when no repository is declared, and declares no deploy key before a source key is stored", () => {
    const { resources, bindings } = load({
      "resources/sanoma/infra.ts": INFRA.replace(/^export const repo = .*\n/m, ""),
    });
    deriveHosts(resources, types, bindings, facts({ sourceKey: undefined }));
    const host = resources.find((r) => r.id.endsWith("#host"))!;
    expect(host.desired.source).toBe("https://github.com/acme/company.git");
    expect(resources.some((r) => r.type === "repository_deploy_key")).toBe(false);
  });

  it("declares no deploy key of its own beside one a data file of before declares with the same key", () => {
    const declared = `export const deployKey = github.repository_deploy_key({ repository: repo, title: "Sanoma host", key: "ssh-rsa AAAA public-half", read_only: true });\n`;
    const { resources, bindings } = load({ "resources/sanoma/infra.ts": INFRA + declared });
    deriveHosts(resources, types, bindings, facts());
    expect(resources.filter((r) => r.type === "repository_deploy_key").map((r) => r.id)).toEqual([
      "resources/sanoma/infra.ts#deployKey",
    ]);
  });

  it("is a problem twice over: two hosts would attach the sites' domains", () => {
    const second = 'export const staging = acme.service({ name: "staging", database: store });\n';
    const { resources, bindings } = load({ "resources/sanoma/infra.ts": INFRA + second });
    const problems = deriveHosts(resources, types, bindings, facts());
    expect(problems.map((p) => p.export)).toEqual(["host", "staging"]);
  });

  it("says what it cannot tell: no database, no installed sanoma, no source", () => {
    const { resources, bindings } = load({
      "resources/sanoma/infra.ts": INFRA.replace(/^export const repo = .*\n/m, "").replace(", database: store", ""),
    });
    const problems = deriveHosts(resources, types, bindings, facts({ version: undefined, origin: undefined }));
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("sanoma is not installed"),
      expect.stringContaining("the repository has no origin"),
      expect.stringContaining("declare the database it runs on"),
    ]);
  });

  it("never counts its deploy key's binding an orphan, declared this read or not", () => {
    const root = tree("host-derive-orphan", {
      "resources/sanoma/infra.ts": INFRA,
      "resources/sanoma.lock.json": JSON.stringify({
        "resources/sanoma/infra.ts#host.sourceKey": { type: "github.repository_deploy_key", id: "42" },
        "resources/sanoma/infra.ts#gone": { type: "acme.db", id: "gone" },
      }),
    });
    const { orphans } = describeConfig({ workflows: [], connectors: [acme, github], root });
    expect(orphans.map((o) => o.key)).toEqual(["resources/sanoma/infra.ts#gone"]);
  });

  it("binds by a lockfile entry of the type it was known by before", () => {
    const { problems } = load({
      "resources/sanoma/infra.ts": INFRA,
      "resources/sanoma.lock.json": JSON.stringify({
        "resources/sanoma/infra.ts#host": { type: "acme.container", id: "company" },
      }),
    });
    expect(problems).toEqual([]);
  });

  it("is described with a problem for a site's domain that is its hostname too", () => {
    const root = tree("host-derive-domains", {
      "resources/sanoma/infra.ts": INFRA.replace("internal.acme.example", "www.acme.example"),
      "sites/www/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true, domain: "www.acme.example" });\n',
      "sites/www/routes/index.tsx": 'import { createFileRoute } from "@tanstack/react-router";\n',
    });
    const { problems } = describeConfig({ workflows: [], connectors: [acme, github], root });
    expect(problems).toContainEqual(
      expect.objectContaining({ message: "www.acme.example is the app's hostname and the domain of www" }),
    );
  });
});

/** `files` loaded and derived over `facts(overrides)`: the resources, the problems, what is kept and left out, the host. */
const derived = (files: Record<string, string>, overrides: Partial<HostFacts> = {}, typesOf = types) => {
  const { resources, bindings } = load(files);
  const out = { keep: new Set<string>(), leftOut: new Set<string>() };
  const problems = deriveHosts(resources, typesOf, bindings, facts(overrides), out);
  const host = resources.find((r) => r.id === "resources/sanoma/infra.ts#host")!;
  return { resources, problems, out, host, secrets: host.desired.secrets as Record<string, unknown> };
};

describe("what a host that derives is given, or refused", () => {
  it("finds its deploy key by the repository and the key, so a key GitHub holds already is bound", () => {
    const { resources } = derived({ "resources/sanoma/infra.ts": INFRA });
    expect(resources.find((r) => r.id === sourceKeyId("resources/sanoma/infra.ts#host"))).toMatchObject({
      identity: "acme/company:ssh-rsa AAAA public-half",
      name: "host.sourceKey",
    });
  });

  it("is named after its repository when its file leaves out its name", () => {
    const { host, problems } = derived({
      "resources/sanoma/infra.ts": INFRA.replace('name: "company", hostname', "hostname"),
    });
    expect(problems).toEqual([]);
    expect(host).toMatchObject({ identity: "company", name: "company", desired: { name: "company" } });
    // From the origin's URL when no repository is declared, made a name.
    const fromOrigin = derived(
      {
        "resources/sanoma/infra.ts": INFRA.replace(/^export const repo = .*\n/m, "").replace(
          'name: "company", hostname',
          "hostname",
        ),
      },
      { origin: "https://github.com/acme/Company_Ops.git" },
    );
    expect(fromOrigin.host.desired.name).toBe("company-ops");
  });

  it("is given the signing key the config binds, else its own, generated at its create", () => {
    expect(derived({ "resources/sanoma/infra.ts": INFRA }).secrets.SANOMA_SIGNING_KEY).toEqual({
      $secret: HOST_SIGNING_KEY,
      generate: true,
    });
    expect(
      derived({ "resources/sanoma/infra.ts": INFRA }, { signingKeyBound: true }).secrets.SANOMA_SIGNING_KEY,
    ).toEqual({ $secret: "SANOMA_SIGNING_KEY" });
  });

  it("is left out, saying how to bind it, for a credential read from this machine's environment alone", () => {
    const { problems, out, secrets } = derived(
      { "resources/sanoma/infra.ts": INFRA },
      { unbound: new Map([["acme", ["ACME_REGION_TOKEN"]]]) },
    );
    expect(problems.map((p) => p.message)).toEqual([
      'host: ACME_REGION_TOKEN is read from the environment here, and has no binding, so the host would not be given it: bind it in sanoma.config.ts, `secrets: { bindings: { ACME_REGION_TOKEN: { env: "ACME_REGION_TOKEN" } } }`, or store it on the acme connector page',
    ]);
    expect(secrets).not.toHaveProperty("ACME_REGION_TOKEN");
    expect([...out.leftOut]).toEqual(["resources/sanoma/infra.ts#host"]);
    // Its deploy key is not declared while it is left out, and its binding is kept.
    expect([...out.keep]).toEqual([sourceKeyId("resources/sanoma/infra.ts#host")]);
  });

  it("is given no source key where the config cannot declare a deploy key, and a private repository is a problem", () => {
    const noKeys = new Map([...types].filter(([id]) => id !== "github.repository_deploy_key"));
    const files = { "resources/sanoma/infra.ts": INFRA.replace(/^export const repo = .*\n/m, "") };
    const open = derived(files, { publicRepository: true, sourceKey: undefined }, noKeys);
    expect(open.problems).toEqual([]);
    expect(open.secrets).not.toHaveProperty("SANOMA_SOURCE_KEY");
    expect(open.resources.some((r) => r.type === "repository_deploy_key")).toBe(false);
    const closed = derived(files, { publicRepository: false, sourceKey: undefined }, noKeys);
    expect(closed.problems.map((p) => p.message)).toEqual([
      expect.stringContaining(
        "acme/company is private, and the config has no github.repository_deploy_key to give the host a key to clone it with: add the GitHub connector",
      ),
    ]);
    expect([...closed.out.leftOut]).toEqual(["resources/sanoma/infra.ts#host"]);
  });

  it("would detach the domains its Worker has while no site declares one: apply says so instead", () => {
    const state = { domains: { www: "www.acme.example" } };
    expect(detaching(spec, {}, state)).toEqual(["www.acme.example (www)"]);
    expect(detaching(spec, { domains: { docs: "docs.acme.example" } }, state)).toEqual([]);
    expect(detaching(spec, {}, {})).toEqual([]);
    expect(detaching({ ...spec, derives: false }, {}, state)).toEqual([]);
  });
});

describe("a clone URL", () => {
  it.each([
    ["git@github.com:acme/company.git", "https://github.com/acme/company.git"],
    ["ssh://git@github.com/acme/company", "https://github.com/acme/company.git"],
    ["https://x-access-token:ghs_secret@github.com/acme/company", "https://github.com/acme/company.git"],
    ["https://gitlab.example/acme/company.git", "https://gitlab.example/acme/company.git"],
  ])("%s is taken as %s, with no credentials", (url, taken) => {
    expect(cloneUrl(url)).toBe(taken);
  });

  it("names its GitHub repository", () => {
    expect(githubRepository("git@github.com:acme/company.git")).toBe("acme/company");
    expect(githubRepository("https://gitlab.example/acme/company.git")).toBeUndefined();
  });
});
