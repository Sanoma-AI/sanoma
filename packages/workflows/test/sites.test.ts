import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import { defineConnector, defineWorkflow, type SanomaConfig } from "../src/index.ts";
import { leads } from "../../app/test/fixtures/company-sites/resources/data.ts";
import { tree } from "./tree.ts";

// What a company's sites call, read from their source (`readSites`) as `describeConfig` reads it:
// the app's company-sites fixture, and sites made here for what it does not hold.

const hello = defineWorkflow({
  name: "hello",
  trigger: "manual",
  input: z.object({ who: z.string() }),
  uses: [],
  run: async () => ({}),
});
const outboundNext = defineWorkflow({
  name: "outbound-next",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => ({}),
});
const acme = defineConnector("acme", {
  customer: {
    get: {
      effect: "read",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      target: ({ id }: { id: string }) => `customer/${id}`,
    },
    rename: {
      effect: "write",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      target: ({ id }: { id: string }) => `customer/${id}`,
    },
  },
});

const config = (root: string, more: Partial<SanomaConfig> = {}): SanomaConfig => ({
  root,
  workflows: [hello],
  connectors: [],
  collections: [leads],
  ...more,
});

/** A page at `path` importing `imports`, whose component renders `body`. */
const page = (path: string, imports: string, body: string) => `import { createFileRoute } from "@tanstack/react-router";
${imports}

export const Route = createFileRoute("${path}")({ component: Page });

function Page() {
  ${body}
}
`;

describe("readSites", () => {
  it("reads the fixture's site: its title, and each RunForm and api call with its file, place and page", () => {
    const root = fileURLToPath(new URL("../../app/test/fixtures/company-sites/", import.meta.url));
    const { sites } = describeConfig(config(root));
    expect(sites).toEqual([
      {
        name: "hello",
        title: "Hello desk",
        calls: [
          // A component's, which is no page; its call by a name not written out is skipped.
          {
            kind: "workflow",
            target: "hello",
            via: "api",
            file: "sites/hello/components/greet.tsx",
            line: 8,
            column: 49,
          },
          {
            kind: "collection",
            target: "leads",
            via: "api",
            file: "sites/hello/routes/leads.tsx",
            line: 7,
            column: 17,
            page: "/sites/hello/leads",
          },
          {
            kind: "workflow",
            target: "hello",
            via: "RunForm",
            file: "sites/hello/routes/run.tsx",
            line: 9,
            column: 7,
            page: "/sites/hello/run",
          },
          {
            kind: "workflow",
            target: "hello",
            via: "api",
            file: "sites/hello/routes/started.tsx",
            line: 8,
            column: 32,
            page: "/sites/hello/started",
          },
        ],
        problems: [],
      },
    ]);
  });

  it("resolves api names to workflows, collections and operations, and makes a problem of each that does not exist", () => {
    const root = tree("calls", {
      "sites/desk/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Front desk" });\n',
      "sites/desk/routes/index.tsx": page(
        "/sites/desk/",
        'import { RunForm } from "@sanoma-ai/app/ui";\nimport { api as sanoma } from "@sanoma-ai/app/site";',
        [
          "void sanoma.outboundNext({});",
          "void sanoma.acme.customer.get({ id: '1' });",
          'void sanoma["hello"].latest();',
          "void sanoma.gone.start({});",
          "void sanoma.data.nope.list();",
          "void sanoma.acme.customer.nope({});",
          "void sanoma.acme.customer.rename({ id: '1' });",
          'void sanoma["outbound-next"]();',
          'return <RunForm workflow={"gone"} />;',
        ].join("\n  "),
      ),
      // Groups and pathless segments are not in the page's path.
      "sites/desk/routes/(admin)/_auth/settings.tsx": page(
        "/sites/desk/(admin)/_auth/settings",
        'import { api } from "sanoma/site";',
        "return api.data.leads.save({ company: 'Acme', stage: 'new' });",
      ),
      // Names not written out, a namespace import and a type-only one: none read; a path passed on is.
      "sites/desk/components/dynamic.tsx": [
        'import * as site from "sanoma/site";',
        'import type { api as typed } from "sanoma/site";',
        'import { api } from "sanoma/site";',
        'import { RunForm } from "@sanoma-ai/app/ui";',
        "export const call = (name: string, form: string) => [",
        "  api[name].start({}),",
        "  api.data[name].list(),",
        "  api[`${name}`](),",
        "  site.api.hello.start({}),",
        "  <RunForm workflow={form} />,",
        "  <RunForm workflow={`${form}`} />,",
        "];",
        "export type Typed = typeof typed;",
        "export const ref = { queryFn: api.data.leads.list };",
        "",
      ].join("\n"),
      // A test is not read; a lazy route's page is its id's.
      "sites/desk/components/x.test.tsx": 'import { api } from "sanoma/site";\nexport const x = () => api.gone();\n',
      "sites/desk/routes/later.lazy.tsx": [
        'import { createLazyFileRoute } from "@tanstack/react-router";',
        'import { api } from "sanoma/site";',
        "",
        'export const Route = createLazyFileRoute("/sites/desk/later")({ component: () => void api.hello.latest() });',
        "",
      ].join("\n"),
      // A site with no calls, and no site.ts.
      "sites/quiet/routes/index.tsx": page("/sites/quiet/", "", "return null;"),
      // Not sites: a name that is no URL segment, and a folder with no routes/.
      "sites/Bad_Name/routes/index.tsx": page("/sites/Bad_Name/", 'import { api } from "sanoma/site";', "api.gone();"),
      "sites/notes/components/x.tsx": 'import { api } from "sanoma/site";\nexport const x = () => api.gone();\n',
    });
    const { sites } = describeConfig(config(root, { workflows: [hello, outboundNext], connectors: [acme] }));
    const index = "sites/desk/routes/index.tsx";
    const at = (line: number, column: number) => ({ file: index, line, column, page: "/sites/desk" });
    expect(sites).toEqual([
      {
        name: "desk",
        title: "Front desk",
        calls: [
          {
            kind: "collection",
            target: "leads",
            via: "api",
            file: "sites/desk/components/dynamic.tsx",
            line: 14,
            column: 31,
          },
          {
            kind: "collection",
            target: "leads",
            via: "api",
            file: "sites/desk/routes/(admin)/_auth/settings.tsx",
            line: 7,
            column: 10,
            page: "/sites/desk/settings",
          },
          { kind: "workflow", target: "outbound-next", via: "api", ...at(8, 8) },
          { kind: "op", target: "acme.customer.get", via: "api", ...at(9, 8) },
          { kind: "workflow", target: "hello", via: "api", ...at(10, 8) },
          { kind: "workflow", target: "gone", via: "api", ...at(11, 8) },
          { kind: "collection", target: "nope", via: "api", ...at(12, 8) },
          { kind: "op", target: "acme.customer.nope", via: "api", ...at(13, 8) },
          { kind: "op", target: "acme.customer.rename", via: "api", ...at(14, 8) },
          // A workflow by its name, not its api name: `callApi` would not find it.
          { kind: "workflow", target: "outbound-next", via: "api", ...at(15, 8) },
          { kind: "workflow", target: "gone", via: "RunForm", ...at(16, 10) },
          {
            kind: "workflow",
            target: "hello",
            via: "api",
            file: "sites/desk/routes/later.lazy.tsx",
            line: 4,
            column: 87,
            page: "/sites/desk/later",
          },
        ],
        problems: [
          { file: index, line: 11, column: 8, message: 'calls workflow "gone", which does not exist' },
          { file: index, line: 12, column: 8, message: 'calls collection "nope", which does not exist' },
          { file: index, line: 13, column: 8, message: 'calls operation "acme.customer.nope", which does not exist' },
          {
            file: index,
            line: 14,
            column: 8,
            message:
              'calls operation "acme.customer.rename", which a page may not call directly: start a workflow that calls it',
          },
          { file: index, line: 15, column: 8, message: 'calls workflow "outbound-next", which does not exist' },
          { file: index, line: 16, column: 10, message: 'calls workflow "gone", which does not exist' },
        ],
      },
      { name: "quiet", calls: [], problems: [] },
    ]);
  });

  it("finds no sites in a root without sites/, or a config without a root", () => {
    expect(describeConfig(config(tree("empty"))).sites).toEqual([]);
    const { root: _, ...rootless } = config("");
    expect(describeConfig(rootless).sites).toEqual([]);
  });
});
