import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import {
  allowAll,
  cedarPolicy,
  defineConnector,
  defineWorkflow,
  loadPolicies,
  readPolicyFiles,
  type Policy,
  resolveConfig,
  type SanomaConfig,
} from "@sanoma-ai/workflows";
import { describeConfig, readPeople } from "@sanoma-ai/workflows/describe";
import { personsOf } from "@sanoma-ai/workflows/shared";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import people from "../../workflows/test/fixtures/people/sanoma.config.ts";
import { ACTOR_COOKIE, ACTOR_KEY } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { spanLines } from "../src/lib/lines.ts";
import { permissions } from "../src/server/core.ts";

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

const config: SanomaConfig = { workflows: [refund], connectors: [withFake(shop, fake)], root };
// The root's policy, made from policies/refunds.cedar.
const resolved = resolveConfig(config);
const cedar = resolved.policy;
const description = describeConfig(config);

/** A public site, so the grid shows a visitor's columns. */
const site = { name: "www", public: true as const, calls: [], problems: [] };

/** The grid under `policy`, as `getPermissions` answers it, `described` as the description says it, beside a public site. */
const gridOf = (policy: Policy, described = description.policy) =>
  permissions({
    resolved: { ...resolved, policy },
    description: { ...description, policy: described, sites: [site] },
    policyFiles: readPolicyFiles(root),
  });

describe("the Permissions grid", () => {
  const hold = {
    answer: "hold",
    rule: { id: "policies/refunds.cedar#1", file: "policies/refunds.cedar", title: "Refunds need finance" },
    approver: { group: "finance" },
  };

  // A visitor, signed in or not, whom no permit lets start a run or call directly.
  const visitorDenied = [{ answer: "deny" }, { answer: "deny" }];

  it("asks the policy for someone in no group and in each group, the start of each workflow, the operations it uses and each direct operation", () => {
    const grid = gridOf(cedar);
    expect(grid).toMatchObject({
      policy: { defined: true },
      groups: [null, "agents", "finance", "visitors", "anonymous"],
    });
    expect(grid.workflows).toEqual([
      {
        id: "refund",
        title: "Refund",
        // Someone in finance is not held: the hold's own approver.
        cells: [hold, hold, { answer: "allow" }, ...visitorDenied],
        // The money operation, called only in a run, under the workflow that uses it.
        ops: [
          {
            id: "shop.refunds.create",
            cells: [
              { answer: "allow" },
              {
                answer: "hold",
                rule: { id: "agent-refunds", file: "policies/refunds.cedar", title: "Agent refunds need finance" },
                approver: { group: "finance" },
              },
              { answer: "allow" },
              // In a run a visitor was let start, its calls are anyone's.
              { answer: "allow" },
              { answer: "allow" },
            ],
          },
        ],
      },
    ]);
    expect(grid.ops).toEqual([
      {
        // A money operation is called only in a run: not a direct row.
        id: "shop.refunds.list",
        cells: [
          { answer: "allow" },
          {
            answer: "deny",
            rule: { id: "no-agent-reads", file: "policies/refunds.cedar", reason: "Agents read no refunds" },
          },
          { answer: "allow" },
          ...visitorDenied,
        ],
      },
    ]);
  });

  it("shows a visitor's columns only beside a public site", () => {
    expect(permissions({ resolved: { ...resolved }, description }).groups).toEqual([null, "agents", "finance"]);
    expect(gridOf(cedar).groups).toEqual([null, "agents", "finance", "visitors", "anonymous"]);
  });

  it("holds an agent for whom it acts for, and refuses everyone else that hold", () => {
    const onBehalf = cedarPolicy(
      resolved,
      loadPolicies([
        {
          file: "policies/agents.cedar",
          text: '@hold("on-behalf-of")\nforbid (principal, action == Sanoma::Action::"shop.refunds.list", resource);\n',
        },
      ]).policies,
      readPeople(root).people,
    );
    const rule = { id: "policies/agents.cedar#1", file: "policies/agents.cedar" };
    expect(gridOf(onBehalf).ops[0]!.cells).toEqual([
      { answer: "deny", rule },
      { answer: "hold", rule, approver: "whom it acts for" },
      { answer: "deny", rule },
      ...visitorDenied,
    ]);
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

  it("is every cell allow with no policy, but a visitor's start and direct call", () => {
    const none = gridOf(allowAll, { defined: false });
    expect(none.policy.defined).toBe(false);
    const allowed = Array.from({ length: 3 }, () => ({ answer: "allow" }));
    expect([...none.workflows, ...none.workflows.flatMap((w) => w.ops), ...none.ops].map((row) => row.cells)).toEqual([
      [...allowed, ...visitorDenied],
      [...allowed, { answer: "allow" }, { answer: "allow" }],
      [...allowed, ...visitorDenied],
    ]);
  });
});

describe("the picker's people", () => {
  it("are the declared persons, not agents nor groups, with their names; none when no one is declared", () => {
    expect(personsOf(readPeople(root).people)).toEqual([{ id: "ada", name: "Ada Lovelace" }, { id: "bo" }]);
    // Then the dialog asks for a name, as it did before people were declared.
    expect(personsOf([])).toEqual([]);
  });
});

describe("the Permissions page", () => {
  const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("permissions") });
  let app: App;

  beforeAll(async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    app = await startApp(testApp.config, { port: 0 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("puts Permissions in the bar, the policy in its panel and header, and a cell per group", async () => {
    const res = await fetch(new URL("/permissions", app.url), {
      headers: { cookie: `${ACTOR_COOKIE}=ada` },
    });
    expect(res.status).toBe(200);
    const html = (await res.text()).replaceAll("<!-- -->", "");
    expect(html).toMatch(/<a [^>]*href="\/permissions"[^>]*>(?:(?!<\/a>)[\s\S])*<span>Permissions<\/span>/);
    expect(html).toContain(">Permissions</h2>");
    expect(html).toContain("Cedar, policies/*.cedar");
    expect(html).toContain(`<code>${cedar.version}</code>`);
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
    // No public site, so no visitor's columns.
    expect(html.match(/>allow</g)).toHaveLength(5);
    // The policy file under the grid, titled by its path, its text plain until the code loads.
    expect(html).toContain(">policies/refunds.cedar</h2>");
    expect(html).toContain("forbid (principal, action == Sanoma::Action::&quot;workflow:refund&quot;, resource)");
    expect(html).toContain("unless { principal in Sanoma::Group::&quot;finance&quot; };");
    // The Workflows page says the policy checks every call, at its version.
    const workflows = (await (await fetch(new URL("/workflows", app.url))).text()).replaceAll("<!-- -->", "");
    expect(workflows).toContain(
      `policies/*.cedar check every operation call and run start (version <code>${cedar.version}</code>)`,
    );
  });

  it("picks a declared person, shows their groups, a cell's rule in a sheet, and the New run panel's will-ask line, in Chrome", async (ctx) => {
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
      // Your groups under your name.
      // By its text, not `::-p-text`, which matches the deepest element only: here a span inside.
      await tab.waitForFunction(
        `document.querySelector('[data-slot="sidebar-footer"] .sr-only')?.textContent.includes("finance")`,
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

      // The New run panel says what the policy will ask, for bo and not for ada, who is in finance.
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
