import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig, siteLocales } from "../src/describe.ts";
import { defineConnector, defineWorkflow, type SanomaConfig, withSetup } from "../src/index.ts";
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

/** A vendor with a login half and no operations. */
const auth0 = withSetup(defineConnector("auth0", {}), {
  login: () => ({ verify: async () => null, handle: async () => undefined }),
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

/** Site `name`, a page and a site.ts passing `options` to `defineSite`, one property a line from line 4. */
const site = (name: string, ...options: string[]) => ({
  [`sites/${name}/routes/index.tsx`]: page(`/sites/${name}/`, "", "return null;"),
  [`sites/${name}/site.ts`]: `import { defineSite } from "sanoma/site";\n\nexport default defineSite({\n  ${options.join(",\n  ")},\n});\n`,
});

/** A problem in site `name`'s site.ts, at the property on `line`. */
const problemAt = (name: string, line: number, message: string) => ({
  file: `sites/${name}/site.ts`,
  line,
  column: 3,
  message,
});

/** Site `name` with `site.ts` passing `options` and one page making `calls`, one a line from line 7, column 8. */
const calling = (name: string, options: string[], calls: string[]) => ({
  ...site(name, ...options),
  [`sites/${name}/routes/index.tsx`]: page(
    `/sites/${name}/`,
    'import { api } from "sanoma/site";',
    calls.map((call) => `void ${call};`).join("\n  "),
  ),
});

/** A problem in site `name`'s page (`calling`), at the call on `line`. */
const pageProblem = (name: string, line: number, message: string) => ({
  file: `sites/${name}/routes/index.tsx`,
  line,
  column: 8,
  message,
});

/** A page at `path` whose loader reads `reads`, with `content` imported from `from`. */
const reading = (path: string, reads: string, from = "sanoma/site") =>
  page(path, `import { content } from "${from}";`, `void (${reads});\n  return null;`);

describe("readSites", () => {
  it("reads the fixture's hello site: its title, that it is public, and each RunForm and api call with its file, place and page", () => {
    const root = fileURLToPath(new URL("../../app/test/fixtures/company-sites/", import.meta.url));
    const { sites } = describeConfig(config(root));
    // Its other site, members, is the app's tests'.
    expect(sites.filter((entry) => entry.name === "hello")).toEqual([
      {
        name: "hello",
        title: "Hello desk",
        public: true,
        // A layout and its index are one page; a page per post, the one kind its file reads.
        pages: [
          { path: "/sites/hello" },
          { path: "/sites/hello/leads" },
          { path: "/sites/hello/posts" },
          { path: "/sites/hello/posts/$slug", content: "posts" },
          { path: "/sites/hello/run" },
          { path: "/sites/hello/started" },
        ],
        calls: [
          // A component's, which is no page; its call by a name not written out is skipped.
          {
            kind: "workflow",
            target: "hello",
            method: "start",
            via: "api",
            file: "sites/hello/components/greet.tsx",
            line: 8,
            column: 49,
          },
          {
            kind: "collection",
            target: "leads",
            method: "list",
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
            line: 10,
            column: 7,
            page: "/sites/hello/run",
          },
          {
            kind: "workflow",
            target: "hello",
            method: "start",
            via: "api",
            file: "sites/hello/routes/started.tsx",
            line: 8,
            column: 32,
            page: "/sites/hello/started",
          },
        ],
        // Its policy lets anonymous start hello, and nothing else.
        problems: [
          {
            file: "sites/hello/routes/leads.tsx",
            line: 7,
            column: 17,
            message:
              'a visitor\'s call to collection "leads" is refused: no permit in policies/ names anonymous for data.leads.list. ' +
              'Add: permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"data.leads.list", resource);',
          },
        ],
      },
    ]);
  });

  it("resolves api names to workflows, collections and operations, and makes a problem of each that does not exist", () => {
    const root = tree("calls", {
      "sites/desk/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Front desk" });\n',
      "sites/desk/routes/index.tsx": page(
        "/sites/desk/",
        'import { RunForm } from "sanoma/site";\nimport { api as sanoma } from "@sanoma-ai/app/site";',
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
        'import { RunForm } from "sanoma/site";',
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
        pages: [{ path: "/sites/desk" }, { path: "/sites/desk/later" }, { path: "/sites/desk/settings" }],
        calls: [
          {
            kind: "collection",
            target: "leads",
            method: "list",
            via: "api",
            file: "sites/desk/components/dynamic.tsx",
            line: 14,
            column: 31,
          },
          {
            kind: "collection",
            target: "leads",
            method: "save",
            via: "api",
            file: "sites/desk/routes/(admin)/_auth/settings.tsx",
            line: 7,
            column: 10,
            page: "/sites/desk/settings",
          },
          { kind: "workflow", target: "outbound-next", via: "api", ...at(8, 8) },
          { kind: "op", target: "acme.customer.get", via: "api", ...at(9, 8) },
          { kind: "workflow", target: "hello", method: "latest", via: "api", ...at(10, 8) },
          { kind: "workflow", target: "gone", method: "start", via: "api", ...at(11, 8) },
          { kind: "collection", target: "nope", method: "list", via: "api", ...at(12, 8) },
          { kind: "op", target: "acme.customer.nope", via: "api", ...at(13, 8) },
          { kind: "op", target: "acme.customer.rename", via: "api", ...at(14, 8) },
          // A workflow by its name, not its api name: `callApi` would not find it.
          { kind: "workflow", target: "outbound-next", via: "api", ...at(15, 8) },
          { kind: "workflow", target: "gone", via: "RunForm", ...at(16, 10) },
          {
            kind: "workflow",
            target: "hello",
            method: "latest",
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
      { name: "quiet", pages: [{ path: "/sites/quiet" }], calls: [], problems: [] },
    ]);
  });

  it("reads public and login from site.ts, and makes a problem of each it cannot keep, at its property", () => {
    const root = tree("public", {
      ...site("www", 'title: "Website"', "public: true", 'login: "auth0"'),
      ...site("open", "public: true as const"),
      ...site("off", "public: false"),
      ...site("dynamic", 'title: "Dynamic"', "public: process.env.PUBLIC === '1'", "login: `${process.env.LOGIN}`"),
      ...site("staff", 'title: "Staff"', "public: false", 'login: "auth0"'),
      ...site("missing", 'title: "Missing"', "public: true", 'login: "okta"'),
      ...site("loginless", 'title: "Loginless"', "public: true", 'login: "acme"'),
      ...site("quoted", 'public: "yes"', 'login: "auth0"'),
      ...site("spread", 'title: "Spread"', "...{ public: true }"),
      // A site.ts that does not parse.
      "sites/broken/routes/index.tsx": page("/sites/broken/", "", "return null;"),
      "sites/broken/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true \n',
      // Options not written out: a variable.
      "sites/hidden/routes/index.tsx": page("/sites/hidden/", "", "return null;"),
      "sites/hidden/site.ts":
        'import { defineSite } from "sanoma/site";\n\nconst options = { public: true };\nexport default defineSite(options);\n',
    });
    const sites = describeConfig(config(root, { connectors: [acme, auth0] })).sites;
    expect(sites).toEqual([
      {
        name: "broken",
        pages: [{ path: "/sites/broken" }],
        calls: [],
        problems: [expect.objectContaining({ file: "sites/broken/site.ts", line: 4 })],
      },
      {
        name: "dynamic",
        pages: [{ path: "/sites/dynamic" }],
        calls: [],
        title: "Dynamic",
        problems: [
          problemAt("dynamic", 5, "`public` is read without running site.ts: write it as `true` or `false`"),
          problemAt("dynamic", 6, "`login` is read without running site.ts: write it as a string"),
        ],
      },
      {
        name: "hidden",
        pages: [{ path: "/sites/hidden" }],
        calls: [],
        problems: [
          {
            file: "sites/hidden/site.ts",
            line: 4,
            column: 1,
            message:
              'its default export is read without running site.ts: write it as `defineSite({ … })` from "sanoma/site", its options an object literal',
          },
        ],
      },
      {
        name: "loginless",
        pages: [{ path: "/sites/loginless" }],
        calls: [],
        title: "Loginless",
        public: true,
        login: "acme",
        problems: [problemAt("loginless", 6, 'login names "acme", whose connector has no login half')],
      },
      {
        name: "missing",
        pages: [{ path: "/sites/missing" }],
        calls: [],
        title: "Missing",
        public: true,
        login: "okta",
        problems: [problemAt("missing", 6, 'login names "okta", which is not a connector in sanoma.config.ts')],
      },
      { name: "off", pages: [{ path: "/sites/off" }], calls: [], problems: [] },
      { name: "open", public: true, pages: [{ path: "/sites/open" }], calls: [], problems: [] },
      // Its login, a connector with a login half, is fine; what is wrong is `public`.
      {
        name: "quoted",
        pages: [{ path: "/sites/quoted" }],
        calls: [],
        login: "auth0",
        problems: [problemAt("quoted", 4, "`public` is read without running site.ts: write it as `true` or `false`")],
      },
      // What is written is read; a spread could make it public.
      {
        name: "spread",
        pages: [{ path: "/sites/spread" }],
        calls: [],
        title: "Spread",
        problems: [
          problemAt(
            "spread",
            5,
            "each of `defineSite`'s options is read without running site.ts: write it as a property with its name",
          ),
        ],
      },
      {
        name: "staff",
        pages: [{ path: "/sites/staff" }],
        calls: [],
        title: "Staff",
        login: "auth0",
        problems: [problemAt("staff", 6, "a login is for a public site: add `public: true`, or remove `login`")],
      },
      {
        name: "www",
        title: "Website",
        public: true,
        login: "auth0",
        pages: [{ path: "/sites/www" }],
        calls: [],
        problems: [],
      },
    ]);
  });

  it("reads a page per content entry only from a path with one parameter that its file reads one kind's entry by", () => {
    const root = tree("pages", {
      "sites/www/routes/blog.$slug.tsx": reading("/sites/www/blog/$slug", "content.posts.get(params.slug)"),
      // The parameter destructured.
      "sites/www/routes/tags.$tag.tsx": reading("/sites/www/tags/$tag", "content.tags.get(tag)"),
      // The parameter by a computed key; another kind read by another `slug` is no matter.
      "sites/www/routes/guides.$slug.tsx": reading(
        "/sites/www/guides/$slug",
        'content.guides.get(params["slug"]).then((g) => content.authors.get(g.slug))',
      ),
      // Not by the parameter, or a list: no entry.
      "sites/www/routes/notes.$id.tsx": reading(
        "/sites/www/notes/$id",
        "[content.notes.get('x'), content.notes.list()]",
      ),
      "sites/www/routes/two.$a.$b.tsx": reading("/sites/www/two/$a/$b", "content.posts.get(params.a)"),
      "sites/www/routes/both.$slug.tsx": reading(
        "/sites/www/both/$slug",
        "[content.posts.get(params.slug), content.notes.get(params.slug)]",
      ),
      "sites/www/routes/docs.$.tsx": reading("/sites/www/docs/$", "content.docs.get(params._splat)"),
      "sites/www/routes/other.$slug.tsx": reading(
        "/sites/www/other/$slug",
        "content.posts.get(params.slug)",
        "./content.ts",
      ),
    });
    expect(describeConfig(config(root)).sites.map(({ pages }) => pages)).toEqual([
      [
        { path: "/sites/www/blog/$slug", content: "posts" },
        { path: "/sites/www/both/$slug" },
        { path: "/sites/www/docs/$" },
        { path: "/sites/www/guides/$slug", content: "guides" },
        { path: "/sites/www/notes/$id" },
        { path: "/sites/www/other/$slug" },
        { path: "/sites/www/tags/$tag", content: "tags" },
        { path: "/sites/www/two/$a/$b" },
      ],
    ]);
  });

  it("reads a public site's locales from site.ts, its default first, and makes a problem of what it cannot keep", () => {
    const root = tree("locales", {
      ...site("www", "public: true", 'locales: ["en", "fr", "pt-BR"]'),
      ...site("empty", "public: true", "locales: []"),
      ...site("dynamic", "public: true", "locales: process.env.LOCALES"),
      ...site("held", "public: true", "locales: [LANG]"),
      ...site("bad", "public: true", 'locales: ["en", "French"]'),
      ...site("blank", "public: true", 'locales: ["en", ""]'),
      ...site("twice", "public: true", 'locales: ["en", "fr", "en"]'),
      ...site("staff", 'locales: ["en", "fr"]'),
      ...site("unread", "public: isProd", 'locales: ["en", "fr"]'),
      ...site("members", "public: true", 'login: "auth0"', 'locales: ["en", "fr"]'),
    });
    const sites = describeConfig(config(root, { connectors: [auth0] })).sites;
    const languages = (name: string) => sites.find((s) => s.name === name);
    expect(languages("www")).toEqual({
      name: "www",
      public: true,
      locales: ["en", "fr", "pt-BR"],
      pages: [{ path: "/sites/www" }],
      calls: [],
      problems: [],
    });
    // Each at its `locales`, the line after `public: true` (and `login`), or the first.
    const problems = Object.fromEntries(sites.map((s) => [s.name, s.problems.map((p) => [p.line, p.message])]));
    const unreadLocales = "`locales` is read without running site.ts: write it as an array of strings";
    const loginless = "`locales` are for a public site with no login: add `public: true`, or remove `locales`";
    expect(problems).toEqual({
      bad: [[5, '"French" is not a language tag such as "en", "fr" or "pt-BR"']],
      blank: [[5, '"" is not a language tag such as "en", "fr" or "pt-BR"']],
      dynamic: [[5, unreadLocales]],
      empty: [[5, "`locales` names a site's languages, its default first: give one or more, or remove it"]],
      held: [[5, unreadLocales]],
      members: [[6, loginless]],
      staff: [[4, loginless]],
      twice: [[5, '"en" is in `locales` twice']],
      // Said once, at `public`.
      unread: [[4, "`public` is read without running site.ts: write it as `true` or `false`"]],
      www: [],
    });
    // Kept only without a problem.
    expect(sites.filter((s) => s.locales).map((s) => s.name)).toEqual(["www"]);
    expect(siteLocales(root)).toEqual({ www: ["en", "fr", "pt-BR"] });
  });

  it("makes a problem of a public site's start or direct call that no permit could let a visitor make, its conditions aside", () => {
    const root = tree("visitors", {
      "policies/visitors.cedar": [
        // Conditions are left out: a call this may permit is fine.
        'permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:hello", resource)',
        '  when { context.input.who == "world" };',
        // An action group: every read, a direct operation's and a collection's.
        'permit (principal == Sanoma::Principal::"anonymous", action in Sanoma::Action::"effect:read", resource);',
        'permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:outbound-next", resource);',
        "",
      ].join("\n"),
      // No login: anonymous only.
      ...calling(
        "www",
        ["public: true"],
        [
          'api.hello({ who: "world" })',
          "api.acme.customer.get({ id: '1' })",
          "api.data.leads.list()",
          "api.outboundNext.start({})",
          "api.data.leads.save({ company: 'Acme', stage: 'new' })",
          // Whatever the policy says: a read of runs but a result, and a built-in workflow.
          'api.outboundNext.result("run")',
          "api.outboundNext.latest()",
          "api.call.start({})",
        ],
      ),
      // With a login: anonymous or the visitors.
      ...calling(
        "members",
        ["public: true", 'login: "auth0"'],
        ["api.outboundNext.start({})", "api.data.leads.save({ company: 'Acme', stage: 'new' })"],
      ),
      // Never a visitor's.
      ...calling("desk", ['title: "Desk"'], ["api.outboundNext.start({})"]),
    });
    const readsAndBuiltIns = [
      pageProblem(
        "www",
        13,
        'a visitor\'s call to workflow "outbound-next" is refused: a visitor reads only the result of a run it started',
      ),
      pageProblem(
        "www",
        14,
        "a visitor's call to workflow \"call\" is refused: a visitor may not start the runtime's own workflows",
      ),
    ];
    const configured = config(root, { workflows: [hello, outboundNext], connectors: [acme, auth0] });
    const problems = () => Object.fromEntries(describeConfig(configured).sites.map((s) => [s.name, s.problems]));
    expect(problems()).toEqual({
      desk: [],
      members: [
        pageProblem(
          "members",
          8,
          'a visitor\'s call to collection "leads" is refused: no permit in policies/ names anonymous or visitors for data.leads.save. ' +
            'Add: permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"data.leads.save", resource);',
        ),
      ],
      www: [
        pageProblem(
          "www",
          10,
          'a visitor\'s call to workflow "outbound-next" is refused: no permit in policies/ names anonymous for workflow:outbound-next. ' +
            'Add: permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:outbound-next", resource);',
        ),
        pageProblem(
          "www",
          11,
          'a visitor\'s call to collection "leads" is refused: no permit in policies/ names anonymous for data.leads.save. ' +
            'Add: permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"data.leads.save", resource);',
        ),
        ...readsAndBuiltIns,
      ],
    });

    // While the policies have problems, every call is refused, and they say why: none is checked against them.
    writeFileSync(join(root, "policies/typo.cedar"), "permit (principal, action, resource)\n");
    expect(describeConfig(configured).policy.problems).not.toEqual([]);
    expect(problems()).toEqual({ desk: [], members: [], www: readsAndBuiltIns });
  });

  it("finds no sites in a root without sites/, or a config without a root", () => {
    expect(describeConfig(config(tree("empty"))).sites).toEqual([]);
    const { root: _, ...rootless } = config("");
    expect(describeConfig(rootless).sites).toEqual([]);
  });
});
