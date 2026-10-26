import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crossAppImports, readApps } from "../src/apps.ts";
import { collection } from "../src/collection.ts";
import { describeConfig, generateApi, readPeople, schemaOf, schemaText } from "../src/describe.ts";
import { lintWorkflow } from "../src/lint.ts";
import { loadScenarios } from "../src/scenario.ts";
import { appOfFile } from "../src/paths.ts";
import { apiNameOf, domainsOf, siteDir } from "../src/shared.ts";
import { resolveConfig } from "../src/index.ts";
import { rootWith } from "./harness.ts";
import fixture from "./fixtures/company-apps/sanoma.config.ts";
import { customers as crmCustomers } from "./fixtures/company-apps/apps/crm/resources/data.ts";
import { customers as shopCustomers } from "./fixtures/company-apps/apps/shop/resources/data.ts";
import followUp from "./fixtures/company-apps/apps/crm/workflows/follow-up.ts";
import thank from "./fixtures/company-apps/apps/shop/workflows/follow-up.ts";
import introduce from "./fixtures/company-apps/workflows/introduce.ts";

// The company-apps fixture: two apps, crm and shop, that both declare `customers` and a
// `follow-up`, and the company's own workflow between them. Its workflows and collections as the
// launcher finds them (`loadConfig`, in the sanoma package).
const root = fileURLToPath(new URL("./fixtures/company-apps/", import.meta.url));
const config = {
  ...fixture,
  workflows: [followUp, thank, introduce],
  collections: [crmCustomers, shopCustomers],
};

describe("apps", () => {
  it("names what an app's folder declares with the folder, and what the root declares as written", () => {
    expect([crmCustomers.name, crmCustomers.app, shopCustomers.name]).toEqual([
      "crm.customers",
      "crm",
      "shop.customers",
    ]);
    expect(crmCustomers.get.id).toBe("data.crm.customers.get");
    expect([followUp.name, followUp.app, thank.name, introduce.name, introduce.app]).toEqual([
      "crm.follow-up",
      "crm",
      "shop.follow-up",
      "introduce",
      undefined,
    ]);
    expect(apiNameOf(followUp.name)).toBe("crmFollowUp");
    expect(appOfFile(followUp.file)).toBe("crm");
    // A package's file is no company's, whatever its path.
    expect(appOfFile(fileURLToPath(import.meta.url))).toBeUndefined();
    // An app merged from a company's repo keeps its config and its package.json: still the app.
    const merged = rootWith({
      "sanoma.config.ts": "",
      "apps/crm/sanoma.config.ts": "",
      "apps/crm/package.json": "{}",
      "node_modules/x/apps/y/z.ts": "",
    });
    expect(appOfFile(join(merged, "apps/crm/workflows/a.ts"))).toBe("crm");
    expect(appOfFile(join(merged, "node_modules/x/apps/y/z.ts"))).toBeUndefined();
  });

  it("names an app's site by its key, in a host's domains too", () => {
    expect(domainsOf("crm/pipeline=crm.acme.test,www=acme.test")).toEqual({
      "crm/pipeline": "crm.acme.test",
      www: "acme.test",
    });
    expect(() => domainsOf("My-CRM/pipeline=crm.acme.test")).toThrow(/^SANOMA_DOMAINS has/);
    expect([siteDir("crm/pipeline"), siteDir("www")]).toEqual(["apps/crm/sites/pipeline", "sites/www"]);
  });

  it("refuses people an app declares: they are the company's", () => {
    const other = rootWith({
      "sanoma.config.ts": "",
      "apps/crm/resources/people.ts":
        'import { sanoma } from "sanoma/resources";\n\nexport const eve = sanoma.person({ id: "eve" });\n',
    });
    expect(readPeople(other)).toEqual({
      people: [],
      problems: [
        {
          file: "apps/crm/resources/people.ts",
          message:
            "apps/crm/resources/people.ts#eve declares a person in an app: the people are the company's, declared in resources/ at the root",
        },
      ],
    });
  });

  it("refuses a collection or a site at the root named as an app is", () => {
    const other = rootWith({
      "sanoma.config.ts": "",
      "apps/crm/app.ts": 'import { defineApp } from "sanoma";\nexport default defineApp({});\n',
      "sites/crm/routes/index.tsx": "",
    });
    const crm = collection({ name: "crm", key: "id", fields: { id: "text" } });
    const { problems } = describeConfig({ connectors: [], collections: [crm], root: other });
    expect(problems.map((p) => [p.file, p.message])).toEqual([
      ["resources/data.ts", "the collection crm is named as the app apps/crm is: name it otherwise"],
      ["sites/crm", "the site crm is named as the app apps/crm is: name it otherwise"],
    ]);
  });

  it("reads each app's app.ts without running it, and refuses a folder that is no app's name", () => {
    expect(readApps(root)).toEqual([
      { name: "crm", dir: "apps/crm", source: "https://github.com/example/crm" },
      { name: "shop", dir: "apps/shop" },
    ]);
    const other = rootWith({
      "sanoma.config.ts": "",
      "apps/My-CRM/app.ts": "",
      "apps/ops/app.ts":
        'import { defineApp } from "sanoma";\nconst source = "x";\nexport default defineApp({ source });\n',
    });
    const { problems } = describeConfig({ connectors: [], root: other });
    expect(problems).toEqual([
      {
        file: "apps/My-CRM",
        line: 1,
        column: 1,
        message:
          "apps/My-CRM is not an app: an app's folder name is a lowercase letter, then lowercase letters and digits",
      },
      {
        file: "apps/ops/app.ts",
        line: 3,
        column: 28,
        message: "`source` is read without running app.ts: write it as a string",
      },
    ]);
  });

  it("describes each kind with its app: workflows, collections and sites, the apps themselves, nothing wrong", () => {
    const description = describeConfig(config);
    expect(description.apps.map((app) => app.name)).toEqual(["crm", "shop"]);
    const own = description.workflows.filter((w) => w.name !== "call");
    expect(own.map(({ name, app, problems }) => ({ name, app, problems }))).toEqual([
      { name: "crm.follow-up", app: "crm", problems: [] },
      { name: "introduce", app: undefined, problems: [] },
      { name: "shop.follow-up", app: "shop", problems: [] },
    ]);
    const outline = own[0]!.outline;
    expect("nodes" in outline && outline.nodes.map((n) => (n.kind === "op" ? n.id : n.kind))).toEqual([
      "data.crm.customers.get",
      "branch",
    ]);
    expect(description.collections.map(({ name, app, ops }) => ({ name, app, op: ops[0] }))).toEqual([
      { name: "crm.customers", app: "crm", op: "data.crm.customers.get" },
      { name: "shop.customers", app: "shop", op: "data.shop.customers.get" },
    ]);
    expect(description.collections[0]!.declared).toMatchObject({
      id: "apps/crm/resources/data.ts#customers",
      name: "crm.customers",
    });
    expect(description.sites).toMatchObject([
      {
        name: "crm/pipeline",
        app: "crm",
        title: "Pipeline",
        icon: "kanban",
        pages: [{ path: "/sites/crm/pipeline" }],
        calls: [{ kind: "collection", target: "crm.customers", method: "list" }],
        problems: [],
      },
    ]);
    expect(description.policy).toEqual({ defined: true, version: expect.any(String) });
    expect(description.problems).toEqual([]);
  });

  it("reads an app's collection passed on whole by a site as no call", () => {
    const other = rootWith({
      "sanoma.config.ts": "",
      "sites/p/routes/index.tsx": 'import { api } from "sanoma/site";\nexport const source = api.data.crm.customers;\n',
    });
    const [site] = describeConfig({ connectors: [], collections: [crmCustomers], root: other }).sites;
    expect(site).toMatchObject({ name: "p", calls: [], problems: [] });
  });

  it("types api.data by app, an app's workflow under one name, and names the Cedar actions and entities by app", () => {
    const description = describeConfig(config);
    const { source, problems } = generateApi(description);
    expect(problems).toEqual([]);
    expect(source).toContain("crmFollowUp: WorkflowFn<");
    expect(source).toMatch(/data: \{\n[\s\S]*crm: \{\n[\s\S]*customers: CollectionApi<CrmCustomersRecord>;/);
    expect(source).toMatch(/shop: \{\n[\s\S]*customers: CollectionApi<ShopCustomersRecord>;/);
    const schema = schemaText(schemaOf(resolveConfig(config), readPeople(root).people));
    expect(schema).toContain('action "data.crm.customers.save"');
    expect(schema).toContain('action "workflow:crm.follow-up"');
  });

  it("finds each app's scenarios, named by their path from the root", async () => {
    const { scenarios, errors } = await loadScenarios(resolveConfig(config));
    expect(errors).toEqual([]);
    expect(scenarios.map(({ file, name, workflow }) => [file, name, workflow])).toEqual([
      ["apps/crm/scenarios/follow-up.feature", "A customer is followed up", "crm.follow-up"],
      ["apps/crm/scenarios/follow-up.feature", "Someone unknown is left alone", "crm.follow-up"],
    ]);
  });

  it("lets a workflow import the root's collections and any app's, and warns of an import from one app into another", () => {
    expect(lintWorkflow(readFileSync(introduce.file, "utf8"), introduce.file)).toEqual([]);
    const other = rootWith({
      "sanoma.config.ts": "",
      "apps/a/workflows/x.ts": 'export { y } from "../../b/workflows/y.ts";\n',
      "apps/b/workflows/y.ts": "export const y = 1;\n",
    });
    expect(crossAppImports(other, readApps(other))).toEqual([
      {
        file: "apps/a/workflows/x.ts",
        line: 1,
        column: 1,
        message:
          'imports "../../b/workflows/y.ts" from the app b: a company may take a without it, so reach it through ctx or api instead',
      },
    ]);
  });
});
