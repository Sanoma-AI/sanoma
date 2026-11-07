import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { executablePath, launch } from "puppeteer-core";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import {
  AuthenticationError,
  defineAuthentication,
  defineConnection,
  defineConnector,
  defineDriver,
  memorySecretStore,
  type SanomaConfig,
  startWorker,
  withSetup,
} from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { CALLBACK_ERRORS } from "../src/api.ts";
import { startApp } from "../src/index.ts";

// OAuth consent in the browser: Connect account on the connector page opens the provider in a new
// tab, the provider (a loopback server here) sends the person back to the app's callback, the
// worker's `connect` run exchanges the code, and the page that started it shows the account
// connected. A callback this browser did not start comes back as a plain `?error=` message.

const CLIENT = { clientId: "acme-app", clientSecret: "acme-app-secret-never-shown" };
const ACCESS = "acme-access-never-shown";
/** The challenge each code was issued for. */
const challenges = new Map<string, string>();

const provider = createServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  if (url.pathname === "/authorize") {
    // Consent given at once: a code for the challenge, back to the redirect URI with the state.
    const code = `code-${challenges.size}`;
    challenges.set(code, url.searchParams.get("code_challenge")!);
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.search = new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString();
    res.writeHead(302, { location: back.href }).end();
  } else if (url.pathname === "/token") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const verifier = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      const ok = challenges.get(form.get("code") ?? "") === verifier;
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok
            ? { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, scope: "read" }
            : { error: "invalid_grant" },
        ),
      );
    });
  } else res.writeHead(404).end();
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((done) => provider.close(() => done())));

const oauth = defineAuthentication({
  kind: "oauth2",
  version: 1,
  storage: { writable: true, conditionalWrites: true, maxBytes: 4096 },
  oauth: {
    authorizeUrl: `${origin}/authorize`,
    tokenUrl: `${origin}/token`,
    scopes: ["read"],
    pkce: true,
    clientAuthentication: "client_secret_basic",
  },
  verify: async (grant) => {
    if (grant.accessToken !== ACCESS) throw new AuthenticationError("rejected");
    return { account: "acme-org", scopes: grant.scopes ?? [], ...(grant.expiresAt && { expiresAt: grant.expiresAt }) };
  },
});
const ops = defineConnector("acme", {
  things: { list: { effect: "read", input: z.object({}), output: z.object({}) } },
});
const acme = withSetup(ops, {
  authentication: { oauth },
  driver: () => defineDriver(ops, { things: { list: async () => ({}) } }, { authentication: ["oauth"] }),
});
const main = defineConnection(acme, {
  name: "main",
  method: "oauth",
  credentials: secret("ACME_MAIN"),
  client: secret("ACME_APP"),
});
const databaseUrl = testDatabaseUrl("app_oauth");
const config: SanomaConfig = {
  databaseUrl,
  workflows: [],
  connectors: [acme],
  connections: [main],
  secrets: { store: memorySecretStore() },
};

// A database of its own, made again for each run: the account starts unconnected.
beforeAll(async () => {
  const db = new Client({ connectionString: Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).href });
  await db.connect();
  await db.query(`DROP DATABASE IF EXISTS "${new URL(databaseUrl).pathname.slice(1)}" WITH (FORCE)`);
  await db.end();
});

it("connects an account by consent in a new tab, and says why a callback it did not start failed", async (ctx) => {
  const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
  if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
  ensureBuilt(
    fileURLToPath(new URL("..", import.meta.url)),
    ["dist/server/server.js"],
    ["pnpm", "exec", "vite", "build"],
  );
  const worker = await startWorker(config);
  const server = await startApp(config, { port: 0 });
  const browser = await launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    await page.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "alice"));
    await page.goto(new URL("/connectors/acme", server.url).href);
    await page.waitForSelector("button::-p-text(Connect account)");
    await page.click("button::-p-text(Connect account)");
    await page.waitForSelector("#oauth-client-secret[type='password']");
    await page.type("#oauth-client-id", CLIENT.clientId);
    await page.type("#oauth-client-secret", CLIENT.clientSecret);
    const consent = new Promise((opened) => browser.once("targetcreated", opened));
    await page.click('[role="dialog"] button[type="submit"]');
    await consent;
    // The other tab came back to the connector page with the attempt alone in its URL.
    const back = await browser.waitForTarget((target) => target.url().includes("/connectors/acme?"));
    const landed = new URL(back.url());
    expect([...landed.searchParams.keys()].toSorted()).toEqual(["attempt", "connection"]);
    // Back on the page that started it, which checks the attempt again as it comes to the front.
    await page.bringToFront();
    await page.waitForFunction(`document.body.textContent.includes('Connected. The account is verified.')`, {
      timeout: 30_000,
    });
    await page.waitForFunction(`document.body.textContent.includes('Access expires')`);
    expect(await page.evaluate(`document.body.textContent`)).toContain("acme-org");
    await page.screenshot({ path: "/tmp/connection-oauth-connected.png", fullPage: true });
    for (const value of [CLIENT.clientSecret, ACCESS]) expect(await page.content()).not.toContain(value);

    // A callback whose state this browser holds no attempt cookie for: refused, said in plain words.
    const stray = await browser.newPage();
    await stray.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "alice"));
    await stray.goto(new URL("/connect/acme/callback?code=forged&state=forged", server.url).href);
    expect(new URL(stray.url()).search).toBe("?error=mismatch");
    await stray.waitForFunction(`document.body.textContent.includes(${JSON.stringify(CALLBACK_ERRORS.mismatch)})`);
  } finally {
    await browser.close();
    await server.close();
    await worker.stop();
  }
}, 120_000);
