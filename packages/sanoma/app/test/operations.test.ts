import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import {
  type AppStepContext,
  type Chat,
  defineConnector,
  defineDriver,
  defineOperation,
  memoryLedger,
  type Principal,
  resolveConfig,
  type SanomaConfig,
  withSetup,
} from "sanoma/workflows";
import { describeConfig } from "sanoma/workflows/describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../workflows/test/fixtures/company-apps/sanoma.config.ts";
import { customers as crmCustomers } from "../../workflows/test/fixtures/company-apps/apps/crm/resources/data.ts";
import { customers as shopCustomers } from "../../workflows/test/fixtures/company-apps/apps/shop/resources/data.ts";
import score from "../../workflows/test/fixtures/company-apps/apps/crm/operations/score.ts";
import quote from "../../workflows/test/fixtures/company-apps/operations/quote.ts";
import offer from "../../workflows/test/fixtures/company-apps/workflows/offer.ts";
import { ACTOR_COOKIE } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { callersOf, operationFile, opHome, vendorsCalling } from "../src/lib/operations.ts";
import { instructions } from "../src/steps/agent/prompt.ts";
import { ensureSanomaBuilt } from "../../test/fixture.ts";

// Needs Postgres (`pnpm db:up`) and the built app (built when stale). The company's own operations
// in the app, on the company-apps fixture (the root's `quote` and the CRM's `score`, which the
// root's `offer` uses): Yours on the Connectors page, an operation's page, the links to it from a
// workflow, a collection and the Permissions grid, as the server renders them; and the operator
// agent's instructions.

const root = fileURLToPath(new URL("../../workflows/test/fixtures/company-apps/", import.meta.url));

// The fixture's operations, the workflow that uses them and the collections they read, as the
// launcher finds them (`loadConfig`).
const config: SanomaConfig = {
  ...fixture,
  workflows: [offer],
  operations: [quote, score],
  collections: [crmCustomers, shopCustomers],
  root,
  ledger: memoryLedger(),
};

const testApp = useTestApp(config, { databaseUrl: testDatabaseUrl("app_operations") });
let app: App;

/**
 * An operation whose file writes no name it has, so its outline cannot be read: given to the app
 * alone, as the worker refuses to start with it.
 */
const unread = defineOperation({
  name: ["un", "read"].join(""),
  input: z.object({}),
  uses: [],
  run: async () => null,
});

/** A vendor's write, which only a workflow may call. */
const acme = defineConnector("acme", {
  customer: {
    rename: {
      effect: "write",
      input: z.object({ id: z.string() }),
      output: z.object({}),
    },
  },
});

/** An operation a page may not call, as it writes at a vendor: given to the app alone, with its connector. */
const relabel = defineOperation({
  name: "relabel",
  input: z.object({ id: z.string() }),
  uses: [acme.customer.rename],
  run: async (ctx, { id }) => ctx.acme.customer.rename({ id }),
});

beforeAll(async () => {
  ensureSanomaBuilt();
  app = await startApp(
    {
      ...testApp.config,
      connectors: [withSetup(acme, { driver: () => defineDriver(acme, { customer: { rename: async () => ({}) } }) })],
      operations: [quote, score, unread, relabel],
    },
    { port: 0 },
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
});

/** A page as the server renders it for ada (the loopback login's cookie), without its scripts. */
async function page(path: string) {
  const res = await fetch(new URL(path, app.url), { headers: { cookie: `${ACTOR_COOKIE}=ada` } });
  const html = (await res.text()).replaceAll("<!-- -->", "");
  return { status: res.status, shown: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "") };
}

describe("the company's operations, in the config", () => {
  const description = describeConfig(config);
  const ops = new Map(description.ops.map((op) => [op.id, op]));
  const op = (id: string) => ops.get(id)!;

  it("finds where each operation is shown: its own page, its collection's, its connector's", () => {
    expect(opHome(description, op("operations.crm.score.run"))).toMatchObject({
      to: "/connectors/operations/$name",
      params: { name: "crm.score" },
    });
    expect(opHome(description, op("data.shop.customers.get"))).toMatchObject({
      to: "/data/$name",
      params: { name: "shop.customers" },
    });
    const vendors = { acme: { title: "Acme", fake: false } };
    expect(opHome({ vendors }, { id: "acme.orders.get", vendor: "acme", resource: "orders" })).toMatchObject({
      to: "/connectors/$vendor",
      params: { vendor: "acme" },
    });
    expect(opHome(description, { ...op("data.shop.customers.get"), vendor: "nobody", resource: "x" })).toBeUndefined();
  });

  it("shows an operation's file from its folder of operations, with /, on Windows too", () => {
    expect(operationFile(op("operations.crm.score.run"))).toBe("apps/crm/operations/score.ts");
    expect(operationFile({ file: "C:\\Users\\ada\\shop\\operations\\quote.ts" })).toBe("operations/quote.ts");
    expect(operationFile({ file: "/home/ada/shop/lib/quote.ts" })).toBe("quote.ts");
    expect(operationFile({ app: "crm", file: "C:\\shop\\apps\\crm\\operations\\score.ts" })).toBe(
      "apps/crm/operations/score.ts",
    );
  });

  it("finds what calls an operation: the workflows using it, and the operations calling it", () => {
    expect(callersOf(description, ["data.shop.customers.get"])).toMatchObject({
      workflows: [],
      operations: [{ id: "operations.quote.run", name: "quote" }],
    });
    expect(callersOf(description, ["operations.quote.run"]).workflows.map((wf) => wf.name)).toEqual(["offer"]);
  });

  it("counts the vendors a workflow reaches only through the calls inside an operation", () => {
    // A vendor as the config lists a connector's, for the collections' operations here.
    const listed = { vendors: { ...description.vendors, data: { title: "Data", fake: false } } };
    expect(vendorsCalling(listed, ops, ["operations.quote.run"])).toEqual([{ id: "data", title: "Data" }]);
    expect(vendorsCalling(description, ops, ["operations.quote.run"])).toEqual([]);
  });
});

describe("the company's operations, in the operator agent's instructions", () => {
  it("lists them in a section of their own, each with its effect, a lookup's too, and what it calls, never as a connector", async () => {
    const step = { config, resolved: resolveConfig(config) } as AppStepContext;
    const text = await instructions(step, { id: "ada", groups: [] } as Principal, { id: "chat-1" } as Chat);
    expect(text).toContain(
      "The company's own operations (operations/ and apps/<name>/operations/), each with its effect and what it calls:\n" +
        // A read that may be called directly is a lookup, as a connector's is.
        "- operations.crm.score.run (read, a lookup): calls data.crm.customers.get\n" +
        "- operations.quote.run (read, a lookup): calls data.shop.customers.get",
    );
    expect(text).not.toMatch(/^- operations \(operations\):/m);
    expect(text).toContain("its connectors: none;");
  });
});

describe("the company's operations, in the app", () => {
  it("lists them under Yours on the Connectors page, above the installed connectors", async () => {
    const { status, shown } = await page("/connectors");
    expect(status).toBe(200);
    const yours = shown.match(/>Yours<[\s\S]*?(?=>Installed<|$)/)?.[0];
    expect(yours).toMatch(/href="\/connectors\/operations\/quote"[\s\S]*>quote<[\s\S]*operations\.quote\.run/);
    expect(yours).toMatch(/href="\/connectors\/operations\/crm\.score"[\s\S]*operations\.crm\.score\.run/);
    expect(yours).toContain(
      "What an order of some items costs a shop customer · Pages and workflows · used by 1 workflow",
    );
    expect(yours).toContain("Workflows only · used by 0 workflows");
  });

  it("shows an operation on its page: where it can run, what it takes, calls and is, and what uses it", async () => {
    const { status, shown } = await page("/connectors/operations/quote");
    expect(status).toBe(200);
    expect(shown).toMatch(/<code[^>]*>operations\.quote\.run<\/code>/);
    expect(shown).toContain("Pages and workflows can call it.");
    // Its own row among the operations called directly.
    expect(shown).toMatch(
      /Who may call it is set in <a[^>]*href="\/permissions#operations\.quote\.run"[^>]*>Permissions<\/a>/,
    );
    // Takes: its input's fields.
    expect(shown).toMatch(/>Takes<[\s\S]*>id<[\s\S]*>items<[\s\S]*>Returns</);
    // Returns: nothing declared, as the operation gives no output schema.
    expect(shown).toMatch(/>Returns<[\s\S]*?Not declared\./);
    // Calls: the collection's operation, linking to the collection.
    expect(shown).toMatch(/>Calls<[\s\S]*href="\/data\/shop\.customers"[\s\S]*data\.shop\.customers\.get/);
    // Code: its file from the root, and the file.
    expect(shown).toMatch(/>Code <code[^>]*>operations\/quote\.ts<\/code>/);
    expect(shown).toContain("defineOperation");
    // Used by: the workflow.
    expect(shown).toMatch(/>Used by<[\s\S]*href="\/workflows\/offer"/);
  });

  it("says what keeps an operation from a page", async () => {
    const { shown } = await page("/connectors/operations/relabel");
    expect(shown).toMatch(/Only workflows can call it: it calls <span><code>acme\.customer\.rename<\/code><\/span>\./);
    // No row of its own: it is under each workflow that uses it.
    expect(shown).toMatch(/Who may call it is set in <a[^>]*href="\/permissions"[^>]*>Permissions<\/a>/);
  });

  it("links an app's operation to its app's Permissions, and its file under the app's folder", async () => {
    const { shown } = await page("/connectors/operations/crm.score");
    expect(shown).toMatch(/href="\/permissions\?app=crm#operations\.crm\.score\.run"[^>]*>Permissions<\/a>/);
    expect(shown).toMatch(/>Code <code[^>]*>apps\/crm\/operations\/score\.ts<\/code>/);
  });

  it("says what is wrong in an operation's file when its outline cannot be read, never that the file is gone", async () => {
    const { status, shown } = await page("/connectors/operations/unread");
    expect(status).toBe(200);
    expect(shown).toMatch(/>Code <code[^>]*>[^<]*operations\.test\.ts<\/code>/);
    expect(shown).toContain("No source to show");
    expect(shown).toContain("operations.test.ts holds no operation named &quot;unread&quot;");
    expect(shown).not.toContain("can no longer be read");
  });

  it("says when no operation has the name", async () => {
    expect((await page("/connectors/operations/nope")).shown).toContain("No operation nope.");
  });

  it("links to it from the workflow that calls it and the collection it reads", async () => {
    expect((await page("/workflows/offer")).shown).toContain('href="/connectors/operations/quote"');
    const collection = (await page("/data/shop.customers")).shown;
    expect(collection).toMatch(/>Used by<[\s\S]*href="\/connectors\/operations\/quote"/);
  });

  it("puts the calls inside an operation under its row in the Permissions grid, linking to its page", async () => {
    const { shown } = await page("/permissions");
    expect(shown).toMatch(
      /href="\/workflows\/offer"[\s\S]*href="\/connectors\/operations\/quote"[^>]*><code[^>]*>operations\.quote\.run<\/code><\/a>[\s\S]*data\.shop\.customers\.get[\s\S]*href="\/connectors\/operations\/crm\.score"/,
    );
  });
});
