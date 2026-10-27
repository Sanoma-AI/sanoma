import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import {
  allowAll,
  defineConnector,
  defineWorkflow,
  readPolicyFiles,
  type Policy,
  resolveConfig,
  type SanomaConfig,
  type Source,
} from "@sanoma-ai/workflows";
import { describeConfig, readPeople } from "@sanoma-ai/workflows/describe";
import { personsOf } from "@sanoma-ai/workflows/shared";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeRemote } from "../../workflows/test/fakes/remote.ts";
import people from "../../workflows/test/fixtures/people/sanoma.config.ts";
import { ACTOR_COOKIE, ACTOR_KEY } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { spanLines } from "../src/lib/lines.ts";
import { hostEnforcement, permissions } from "../src/server/core.ts";

// The Permissions page: its grid and the policy files through the server core
// (`getPermissions`), the page as the server renders it, and in Chrome the who-are-you picker,
// the groups under your name, a cell's rule in its sheet and its lines in the code. The page
// needs Postgres (`pnpm db:up`) and the built app; the test in a browser needs Google Chrome, or
// `CHROME_PATH`, and skips without either.

const appDir = fileURLToPath(new URL("..", import.meta.url));

const shop = defineConnector("shop", {
  refunds: {
    create: { effect: "money", input: z.object({ amount: z.number().int() }), output: z.object({ id: z.string() }) },
    list: { effect: "read", input: z.object({}), output: z.array(z.object({ id: z.string() })) },
  },
});
const fake = defineFake(shop, {
  initial: () => ({}),
  ops: () => ({ refunds: { create: async () => ({ id: "re_1" }), list: async () => [] } }),
});
const refund = defineWorkflow({
  name: "refund",
  title: "Refund",
  trigger: "manual",
  input: z.object({ amount: z.number().int() }),
  uses: [shop.refunds.create],
  run: async (ctx, { amount }) => ctx.shop.refunds.create({ amount }),
});

const root = mkdtempSync(join(tmpdir(), "sanoma-permissions-"));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace" });
export const bo = sanoma.person({ id: "bo" });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const finance = sanoma.group({ name: "finance", members: [ada] });
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A hold on a start, a deny on a direct read and a hold on an operation only a run calls, each
// for those outside a group.
const POLICIES = `@hold("finance")
@title("Refunds need finance")
forbid (principal, action == Sanoma::Action::"workflow:refund", resource)
unless { principal in Sanoma::Group::"finance" };

@id("no-agent-reads")
@reason("Agents read no refunds")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.list", resource);

@id("agent-refunds")
@hold("finance")
@title("Agent refunds need finance")
forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"shop.refunds.create", resource);
`;

mkdirSync(join(root, "policies"));
writeFileSync(join(root, "policies", "refunds.cedar"), POLICIES);

// A host the repository's remote may be on, for the line under the grid: its `enforcement` changed by a test.
const remote = fakeRemote();
/** The repository's remote, as the app's source reports it: none until a test sets one. */
let origin: string | undefined;
const source: Source = { root, commit: () => undefined, head: () => "HEAD", remoteUrl: async () => origin };

const config: SanomaConfig = { workflows: [refund], connectors: [withFake(shop, fake), remote.connector], root };
// The root's policy, made from policies/refunds.cedar.
const resolved = resolveConfig(config);
const cedar = resolved.policy;
const description = describeConfig(config);

/** A public site, so the grid shows a visitor's columns. */
const site = { name: "www", public: true as const, pages: [], calls: [], problems: [], warnings: [] };

/** The grid under `policy`, as `getPermissions` answers it, `described` as the description says it, beside a public site. */
const gridOf = (policy: Policy, described = description.policy) =>
  permissions({
    resolved: { ...resolved, policy },
    description: { ...description, policy: described, sites: [site] },
    policyFiles: readPolicyFiles(root),
  });

describe("the Permissions grid", () => {
  // The grid itself is `permissionsGrid`'s (`packages/workflows/test/grid.test.ts`): here what the app adds.
  it("is the runtime's grid, with the policy as the description says it", () => {
    const grid = gridOf(cedar);
    expect(grid).toMatchObject({
      policy: { defined: true },
      groups: [null, "agents", "finance", "visitors", "anonymous"],
    });
    expect(grid.workflows.map((w) => w.id)).toEqual(["refund"]);
    expect(gridOf(allowAll, { defined: false }).policy.defined).toBe(false);
  });

  it("serves each policy file's text, with each policy's id and where it is, from the people fixture", () => {
    const fixture = resolveConfig(people);
    const filesOf = (policyFiles: { file: string; text: string }[]) =>
      permissions({ resolved: { ...fixture }, description: describeConfig(people), policyFiles }).files;
    const read = readPolicyFiles(fixture.root!);
    const files = filesOf(read);
    const file = "policies/refunds.cedar";
    const text = readFileSync(
      fileURLToPath(new URL(`../../workflows/test/fixtures/people/${file}`, import.meta.url)),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(files).toEqual([
      { file, text, policies: [expect.anything(), expect.anything()] },
      expect.objectContaining({ file: "policies/visitors.cedar" }),
    ]);
    // Written with `\r\n`, served with `\n`, as the Code view counts offsets: the same answer.
    expect(filesOf(read.map((f) => ({ ...f, text: f.text.replaceAll("\n", "\r\n") })))).toEqual(files);
    // Each from its first annotation to its `;`: the file's comment is no policy's.
    expect(files[0]!.policies.map(({ id, span }) => [id, spanLines(text, span)])).toEqual([
      [`${file}#1`, [2, 6]],
      ["no-agent-refunds", [8, 10]],
    ]);
    expect(text.slice(...files[0]!.policies[1]!.span)).toMatch(/^@id\("no-agent-refunds"\)[\s\S]*resource\);$/);
  });
});

describe("what the host enforces", () => {
  const context = { client: undefined as never, description, resolved, source };

  it("is nothing without a remote, or with no connector for its host", async () => {
    expect(await hostEnforcement({ ...context, source: undefined })).toBeNull();
    origin = undefined;
    expect(await hostEnforcement(context)).toBeNull();
    origin = "https://elsewhere.example/acme/company.git";
    expect(await hostEnforcement(context)).toBeNull();
  });

  it("is the host's answer on main, by the connector's name; a host that fails, nothing enforced and why", async () => {
    origin = remote.url;
    expect(await hostEnforcement(context)).toEqual({
      host: "fakegit",
      pullRequest: false,
      check: false,
      reason: "a fake host enforces nothing",
    });
    const { enforcement } = remote.host;
    remote.host.enforcement = async () => {
      throw new Error("the host is down");
    };
    try {
      expect(await hostEnforcement(context)).toEqual({
        host: "fakegit",
        pullRequest: false,
        check: false,
        reason: "the host is down",
      });
    } finally {
      remote.host.enforcement = enforcement;
      origin = undefined;
    }
  });
});

describe("the picker's people", () => {
  it("are the declared persons, not agents nor groups, with their names; none when no one is declared", () => {
    expect(personsOf(readPeople(root).people)).toEqual([{ id: "ada", name: "Ada Lovelace" }, { id: "bo" }]);
    // Then the dialog asks for a name, as it did before people were declared.
    expect(personsOf([])).toEqual([]);
  });
});

/** The Permissions page as ada sees it, as the server renders it. */
const permissionsPage = async (app: App) =>
  (
    await (await fetch(new URL("/permissions", app.url), { headers: { cookie: `${ACTOR_COOKIE}=ada` } })).text()
  ).replaceAll("<!-- -->", "");

describe("the Permissions page", () => {
  const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("permissions") });
  let app: App;

  beforeAll(async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    app = await startApp(testApp.config, { port: 0, source });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("puts Permissions in the bar, the policy beside its title, and a cell per group", async () => {
    const res = await fetch(new URL("/permissions", app.url), {
      headers: { cookie: `${ACTOR_COOKIE}=ada` },
    });
    expect(res.status).toBe(200);
    const html = (await res.text()).replaceAll("<!-- -->", "");
    expect(html).toMatch(
      /<nav aria-label="Sections"[^>]*>(?:(?!<\/nav>)[\s\S])*<a [^>]*href="\/permissions"[^>]*aria-current="page"[^>]*>(?:(?!<\/a>)[\s\S])*Permissions<\/a>/,
    );
    // The title, and beside it the policy: Cedar, its files, its version, and what the grid holds.
    expect(html).toMatch(/<h1[^>]*>Permissions<\/h1>/);
    expect(html).toMatch(
      new RegExp(
        `<p[^>]*>Cedar, <code>policies/\\*\\.cedar</code> · version <code>${cedar.version}</code> · 2 groups · \\d+ workflows? · \\d+ operations?</p>`,
      ),
    );
    expect([...html.matchAll(/<th [^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map(([, name]) => name)).toEqual([
      "No group",
      "agents",
      "finance",
    ]);
    expect(html).toContain('aria-label="hold · group finance: the rule for refund for someone in no group"');
    expect(html).toContain('aria-label="deny: the rule for shop.refunds.list for someone in agents"');
    expect(html).toContain(
      'aria-label="hold · group finance: the rule for shop.refunds.create in refund for someone in agents"',
    );
    // No public site, so no visitor's columns; the built-in sanoma.apps.list's row is allow across.
    expect(html.match(/>allow</g)).toHaveLength(8);
    // The policy file under the grid, titled by its path, its text plain until the code loads.
    expect(html).toContain(">policies/refunds.cedar</h2>");
    expect(html).toContain("forbid (principal, action == Sanoma::Action::&quot;workflow:refund&quot;, resource)");
    expect(html).toContain("unless { principal in Sanoma::Group::&quot;finance&quot; };");
    // The policy is the Permissions page's: the Workflows page says nothing of it while it holds.
    const workflows = (await (await fetch(new URL("/workflows", app.url))).text()).replaceAll("<!-- -->", "");
    expect(workflows).not.toContain("policies/*.cedar");
  });

  it("says under the grid whether the host requires a merge, and nothing without a remote", async () => {
    expect(await permissionsPage(app)).not.toContain("check on <code>main</code>");
    const { enforcement } = remote.host;
    origin = remote.url;
    try {
      expect(await permissionsPage(app)).toContain(
        "fakegit does not require a pull request and the <code>sanoma</code> check on <code>main</code>. a fake host enforces nothing Until then a push around Sanoma lands in the ledger as a gap.",
      );
      remote.host.enforcement = async () => ({ pullRequest: true, check: true });
      const html = await permissionsPage(app);
      expect(html).toContain("fakegit requires a pull request and the <code>sanoma</code> check on <code>main</code>.");
      expect(html).not.toContain("Until then");
    } finally {
      remote.host.enforcement = enforcement;
      origin = undefined;
    }
  });

  it("picks a declared person, shows their groups, a cell's rule in a sheet, and New run's will-ask line, in Chrome", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1440, height: 900 });
      await tab.goto(new URL("/permissions", app.url).href, { waitUntil: "networkidle0" });
      // No name yet: the declared people to choose from, not the agent.
      const picker = await tab.waitForSelector("select#who-name");
      expect(await picker!.evaluate((s) => [...s.options].map((o) => [o.value, o.textContent]))).toEqual([
        ["", "Choose a person"],
        ["ada", "Ada Lovelace (ada)"],
        ["bo", "bo"],
      ]);
      await tab.select("select#who-name", "ada");
      await tab.click('[role="dialog"] button[type="submit"]');
      await tab.waitForFunction(`!document.querySelector("select#who-name")`);
      // Your groups under your name, on the user menu at the bar's foot.
      // By its text, not `::-p-text`, which matches the deepest element only: here a span inside.
      await tab.waitForFunction(
        `document.querySelector('[data-slot="dropdown-menu-trigger"] .sr-only')?.textContent.includes("finance")`,
      );

      // The sheet's text, once it shows the rule.
      const sheet = async (rule: string) => {
        await tab.waitForSelector(`[data-slot="sheet-content"]::-p-text(${rule})`);
        return (await tab.evaluate(`document.querySelector('[data-slot="sheet-content"]').textContent`)) as string;
      };
      await tab.click('button[aria-label="deny: the rule for shop.refunds.list for someone in agents"]');
      const deny = await sheet("no-agent-reads");
      expect(deny).toContain("Agents read no refunds");
      expect(deny).toContain("policies/refunds.cedar");
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(`!document.querySelector('[data-slot="sheet-content"]')`);

      await tab.click('button[aria-label="hold · group finance: the rule for refund for someone in agents"]');
      expect(await sheet("Refunds need finance")).toContain("group finance");
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(`!document.querySelector('[data-slot="sheet-content"]')`);

      await tab.click(
        'button[aria-label="hold · group finance: the rule for shop.refunds.create in refund for someone in agents"]',
      );
      expect(await sheet("Agent refunds need finance")).toContain(
        "Holds shop.refunds.create in Refund for someone in agents.",
      );
      // Show the rule: the sheet closes and the code marks the rule's lines, its annotations too.
      await tab.click('[data-slot="sheet-content"] button::-p-text(Show the rule)');
      await tab.waitForFunction(`!document.querySelector('[data-slot="sheet-content"]')`);
      await tab.waitForSelector(".cm-hl-gutter");
      expect(
        await tab.evaluate(`[...document.querySelectorAll(".cm-hl-gutter")].map((marked) => marked.textContent)`),
      ).toEqual(["10", "11", "12", "13"]);

      // New run says what the policy will ask, for bo and not for ada, who is in finance.
      const newRun = async (who: string) => {
        await tab.evaluate((key, name) => localStorage.setItem(key, name), ACTOR_KEY, who);
        await tab.goto(new URL("/workflows/refund?new", app.url).href, { waitUntil: "networkidle0" });
        await tab.waitForSelector("form");
      };
      await newRun("bo");
      await tab.waitForFunction(`document.body.textContent.includes("Will ask finance before the start.")`);
      await newRun("ada");
      expect(await tab.evaluate("document.body.textContent")).not.toContain("Will ask");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
