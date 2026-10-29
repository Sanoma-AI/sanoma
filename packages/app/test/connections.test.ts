import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import {
  defineAuthentication,
  defineConnection,
  defineConnectionRule,
  defineConnector,
  defineDriver,
  memorySecretStore,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  SecretStoreError,
  withSetup,
} from "@sanoma-ai/workflows";
import { secret } from "../../workflows/src/secret.ts";
import { lazyPool } from "../../workflows/src/db.ts";
import { tree } from "../../workflows/test/tree.ts";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { PreviewConnectionRequest, ConnectConnectionRequest } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { admitting } from "../src/login/admission.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { startApp } from "../src/index.ts";
import {
  asApiError,
  connections,
  connectConnection,
  previewConnection,
  disconnectConnection,
  testConnection,
  validate,
} from "../src/server/core.ts";

const authentication = defineAuthentication({
  kind: "fields",
  version: 1,
  schema: z.object({ user: z.string(), password: z.string() }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 512 },
  verify: async ({ user }) => ({ account: user, scopes: ["messages"] }),
});
const ops = defineConnector("mail", {
  messages: { list: { effect: "read", input: z.object({}), output: z.object({}) } },
});
const mail = withSetup(ops, {
  authentication: { password: authentication },
  driver: () => defineDriver(ops, { messages: { list: async () => ({}) } }, { authentication: ["password"] }),
});
const support = defineConnection(mail, { name: "support", method: "password", credentials: secret("SUPPORT") });
const sales = defineConnection(mail, { name: "sales", method: "password", credentials: secret("SALES") });
const personal = defineConnectionRule(mail, { name: "personal", method: "password", createBy: ["alice"] });
const databaseUrl = testDatabaseUrl("app_connections");
const pool = lazyPool(databaseUrl, "app-connections-tests");
let app: AppContext;
let store: ReturnType<typeof memorySecretStore>;
let config: SanomaConfig;
beforeEach(async () => {
  store = memorySecretStore();
  const cfg = {
    databaseUrl,
    workflows: [],
    connectors: [mail],
    connections: [support, sales],
    connectionRules: [personal],
    secrets: { store },
  };
  const resolved = resolveConfig(cfg);
  config = cfg;
  const client = await SanomaClient.connect(cfg);
  app = {
    resolved,
    client,
    description: describeConfig(cfg),
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  };
  await (
    await pool.db()
  ).query("TRUNCATE sanoma_connections, sanoma_connection_setups, sanoma_connection_health, sanoma_ledger");
});
afterEach(async () => {
  await app?.client.close();
});
afterAll(() => pool.close());
const actor = { id: "alice" };
const credentials = { user: "support@example.test", password: "synthetic-secret-never-return" };

describe("connection server boundary", () => {
  it("connects two accounts through masked forms and reviews the account before saving", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    ensureBuilt(
      fileURLToPath(new URL("..", import.meta.url)),
      ["dist/server/server.js"],
      ["pnpm", "exec", "vite", "build"],
    );
    const server = await startApp(config, { port: 0 });
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      await page.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "alice"));
      await page.goto(new URL("/connectors/mail", server.url).href);
      for (const name of ["support", "sales"]) {
        await page.waitForSelector('[role="listitem"] button');
        const row = `Array.from(document.querySelectorAll('[role="listitem"]')).find(row => row.querySelector('code')?.textContent === ${JSON.stringify(name)})`;
        await page.waitForFunction(row);
        await page.evaluate(
          `Array.from((${row}).querySelectorAll('button')).find(button => button.textContent === 'Connect').click()`,
        );
        await page.waitForSelector('#connection-user[type="password"]');
        expect(await page.evaluate(`document.querySelector('#connection-password').getAttribute('type')`)).toBe(
          "password",
        );
        await page.type("#connection-user", `${name}@example.test`);
        await page.type("#connection-password", credentials.password);
        await page.click('[role="dialog"] button[type="submit"]');
        await page.waitForSelector('[role="dialog"] button::-p-text(Save connection)');
        const review = await page.evaluate(`document.querySelector('[role="dialog"]').textContent`);
        expect(review).toContain(`${name}@example.test`);
        expect(review).toContain(name.toUpperCase());
        expect(review).not.toContain(credentials.password);
        await page.click('[role="dialog"] button[type="submit"]');
        await page.waitForSelector('[role="dialog"]', { hidden: true });
      }
      await page.waitForFunction(`document.body.textContent.includes('sales@example.test')`);
      await page.screenshot({ path: "/tmp/connection-management-accounts.png", fullPage: true });
      expect((await connections(app, actor)).cards.map((card) => card.account)).toEqual([
        "support@example.test",
        "sales@example.test",
      ]);
      expect(
        await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })),
      ).not.toContain(credentials.password);
      expect(await page.content()).not.toContain(credentials.password);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120_000);

  it("returns two declared accounts and authorized creation choices without reading credentials", async () => {
    const read = vi.spyOn(store, "read");
    const result = await connections(app, actor);
    expect(result.cards.map((card) => card.name)).toEqual(["support", "sales"]);
    expect(result.rules.map((rule) => rule.id)).toEqual(["mail/personal"]);
    expect((await connections(app, { id: "bob" })).rules).toEqual([]);
    expect(result.store).toMatchObject({ store: "memory", ready: true });
    expect(result.methods.mail?.password).toMatchObject({
      kind: "fields",
      verifiable: true,
      schema: { type: "object" },
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("verifies, reviews, saves, tests and disconnects through the same actor-scoped calls as the page", async () => {
    const review = await previewConnection(
      app,
      actor,
      validate(PreviewConnectionRequest)({ target: { connection: support }, requestId: randomUUID(), credentials }),
    );
    expect(review).toMatchObject({ account: credentials.user, location: { path: "SUPPORT" } });
    expect(JSON.stringify(review)).not.toContain(credentials.password);
    const saved = await connectConnection(app, actor, validate(ConnectConnectionRequest)({ review, credentials }));
    expect(await testConnection(app, actor, { connection: support, requestId: randomUUID() })).toMatchObject({
      state: "connected",
    });
    expect(JSON.stringify(await connections(app, actor))).not.toContain(credentials.password);
    await disconnectConnection(app, actor, {
      connection: support,
      expectedRevision: saved.revision,
      requestId: randomUUID(),
    });
    expect((await connections(app, actor)).cards.find((card) => card.id === support.$connection)?.status).toBe(
      "disconnected",
    );
    const ledger = await (await pool.db()).query("SELECT row_to_json(l) AS data FROM sanoma_ledger l");
    expect(JSON.stringify(ledger.rows)).not.toContain(credentials.password);
  });
  it("reports a store bootstrap/access failure without leaking the adapter's error", async () => {
    vi.spyOn(store, "validate").mockRejectedValue(new Error("sensitive-provider-request"));
    const result = await connections(app, actor);
    expect(result.store).toMatchObject({ ready: false, problem: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-request");
  });
  it("discards provider messages even on known authentication/store errors", () => {
    expect(
      asApiError({ name: "AuthenticationError", problem: "expired", message: credentials.password }).body.error,
    ).toBe("Authentication: expired");
    const failure = new SecretStoreError("read_only");
    failure.message = credentials.password;
    expect(asApiError(failure).body.error).toBe("Secret store: read only");
  });
  it("refuses policy-denied intake before any secret read or write", async () => {
    const cfg = {
      databaseUrl,
      workflows: [],
      connectors: [mail],
      connections: [support],
      secrets: { store },
      root: tree(`app-connection-denied-${randomUUID()}`, {
        "policies/deny.cedar": 'forbid(principal, action == Sanoma::Action::"sanoma.connection.prepare", resource);',
      }),
    };
    const client = await SanomaClient.connect(cfg);
    const read = vi.spyOn(store, "read");
    const write = vi.spyOn(store, "write");
    try {
      await expect(
        previewConnection({ ...app, client }, actor, {
          target: { connection: support },
          requestId: randomUUID(),
          credentials,
        }),
      ).rejects.toMatchObject({ code: "policy_denied" });
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
