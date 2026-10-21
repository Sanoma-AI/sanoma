import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type App, startApp } from "../src/index.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { GITHUB_APP, githubManifest, setSetupToken, setupStatus } from "../src/server/setup.ts";

// Connecting GitHub and Supabase (/setup/connect): the GitHub App's manifest page, its callback
// against a GitHub of msw handlers, the keys stored encrypted, and the status the page shows.
// Needs Postgres and the built app, as app.test.ts does.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "sanoma-setup-"));
const config = defineConfig({
  workflows: [],
  connectors: [],
  databaseUrl: testDatabaseUrl("setup"),
  root,
});

/** What GitHub hands over for the code `good`: the new App's keys. */
const KEYS = {
  id: 4242,
  slug: "sanoma-acme",
  client_id: "Iv1.clientid",
  client_secret: "client-secret-value",
  webhook_secret: "webhook-secret-value",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nmade-up\n-----END RSA PRIVATE KEY-----\n",
  owner: { login: "acme" },
};
const conversions: string[] = [];
const github = setupServer(
  http.post("https://api.github.com/app-manifests/:code/conversions", ({ params }) => {
    conversions.push(String(params.code));
    return params.code === "good"
      ? HttpResponse.json(KEYS, { status: 201 })
      : HttpResponse.json({ message: "Not Found" }, { status: 404 });
  }),
);

/** The secrets key the app stores under. */
const KEY = randomBytes(32).toString("base64");
const NAMES = [...Object.values(GITHUB_APP), "GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN"];
let app: App;
let client: SanomaClient;
let ctx: AppContext;

beforeAll(async () => {
  vi.stubEnv("SANOMA_SECRETS_KEY", KEY);
  for (const name of NAMES) vi.stubEnv(name, "");
  github.listen({ onUnhandledFrame: "bypass" });
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(config, { port: 0 });
  client = await SanomaClient.connect(config);
  ctx = {
    resolved: resolveConfig(config),
    description: describeConfig(config),
    client,
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  };
  // The table outlives a run of the tests. (Reading prepares the database; rows stored under
  // another key fail to read, and are deleted all the same.)
  await client.secrets(NAMES).catch(() => undefined);
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  await db.query("DELETE FROM sanoma_credentials WHERE name = ANY($1)", [NAMES]);
  await db.end();
});

afterAll(async () => {
  github.close();
  await app?.close();
  await client?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string, cookie?: string) =>
  fetch(new URL(path, app.url), { redirect: "manual", headers: cookie ? { cookie } : {} });

/** The `name=value` of the state cookie a response sets. */
const stateCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((line) => line.startsWith("sanoma_setup_state="))!
    .split(";")[0]!;

/** Text out of an HTML attribute, as the manifest page escapes it. */
const fromAttribute = (text: string) =>
  text.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

/** The manifest page's form: where it posts, and the manifest it carries. */
function form(html: string) {
  const action = new URL(fromAttribute(/<form id="manifest" method="post" action="([^"]+)"/.exec(html)![1]!));
  const manifest = JSON.parse(fromAttribute(/name="manifest" value="([^"]+)"/.exec(html)![1]!)) as unknown;
  return { action, manifest };
}

describe("creating the GitHub App", () => {
  it("posts the manifest to GitHub from a page that submits itself, with the state in a signed cookie", async () => {
    const res = await get("/setup/github/manifest");
    expect(res.status).toBe(200);
    const html = await res.text();
    const { action, manifest } = form(html);
    expect(`${action.origin}${action.pathname}`).toBe("https://github.com/settings/apps/new");
    const state = action.searchParams.get("state")!;
    expect(manifest).toEqual(githubManifest(app.url, `Sanoma ${ctx.description.appName}`));
    expect(manifest).toMatchObject({
      redirect_url: `${app.url}/setup/github/callback`,
      callback_urls: [`${app.url}/auth/github/callback`],
      public: false,
      default_permissions: { administration: "write", contents: "write", metadata: "read", pull_requests: "write" },
      default_events: ["push", "pull_request"],
      hook_attributes: { active: false },
    });
    expect(html).toContain('document.getElementById("manifest").submit()');
    const line = res.headers.getSetCookie().find((l) => l.startsWith("sanoma_setup_state="))!;
    expect(line).toMatch(/Path=\/setup\/github;.*HttpOnly/);
    expect(stateCookie(res)).toMatch(new RegExp(`^sanoma_setup_state=${state}\\.[\\w-]+$`));
  });

  it("creates it in an organization's settings, and refuses a name that is not a login", async () => {
    const { action } = form(await (await get("/setup/github/manifest?org=acme-co")).text());
    expect(`${action.origin}${action.pathname}`).toBe("https://github.com/organizations/acme-co/settings/apps/new");
    const bad = await get("/setup/github/manifest?org=acme%2F..");
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe("/setup/connect?github=bad-org");
  });

  it("refuses a callback whose state is not the cookie's, or whose cookie is not signed here, asking GitHub nothing", async () => {
    const start = await get("/setup/github/manifest");
    const cookie = stateCookie(start);
    const state = cookie.split("=")[1]!.split(".")[0]!;
    for (const [query, sent] of [
      [`code=good&state=other`, cookie],
      [`code=good&state=${state}`, `sanoma_setup_state=${state}.forged`],
      [`code=good&state=${state}`, undefined],
    ] as const) {
      const res = await get(`/setup/github/callback?${query}`, sent);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/setup/connect?github=expired");
    }
    expect(conversions).toEqual([]);
    expect((await setupStatus(ctx)).githubApp).toBeNull();
  });

  it("says so when GitHub will not convert the code", async () => {
    const cookie = stateCookie(await get("/setup/github/manifest"));
    const state = cookie.split("=")[1]!.split(".")[0]!;
    const res = await get(`/setup/github/callback?code=stale&state=${state}`, cookie);
    expect(res.headers.get("location")).toBe("/setup/connect?github=failed");
    expect(conversions).toEqual(["stale"]);
  });

  it("exchanges the code and stores the App's keys encrypted, under their own names", async () => {
    const cookie = stateCookie(await get("/setup/github/manifest"));
    const state = cookie.split("=")[1]!.split(".")[0]!;
    const res = await get(`/setup/github/callback?code=good&state=${state}`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/connect?github=connected");
    // The state cookie is used once.
    expect(stateCookie(res)).toBe("sanoma_setup_state=");

    const stored = await client.secrets(Object.values(GITHUB_APP));
    expect([...stored.keys()].toSorted()).toEqual(Object.values(GITHUB_APP).toSorted());
    expect(stored.get(GITHUB_APP.client_secret)).toMatchObject({ value: KEYS.client_secret, setBy: "acme" });
    expect(stored.get(GITHUB_APP.id)?.value).toBe("4242");
    expect(stored.get(GITHUB_APP.pem)?.value).toBe(KEYS.pem);
    // Encrypted: under another key, nothing reads.
    vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
    await expect(client.secrets([GITHUB_APP.pem])).rejects.toThrow(/cannot be decrypted/);
    vi.stubEnv("SANOMA_SECRETS_KEY", KEY);
  });
});

describe("the connect page", () => {
  it("says what is connected, and stores a pasted token, never showing a value", async () => {
    expect(await setupStatus(ctx)).toEqual({
      githubApp: { slug: KEYS.slug, setBy: "acme", setAt: expect.any(String) },
      tokens: [
        expect.objectContaining({ name: "GITHUB_TOKEN", status: "missing" }),
        expect.objectContaining({ name: "SUPABASE_ACCESS_TOKEN", status: "missing" }),
      ],
    });
    await setSetupToken(ctx, { id: "alice" }, { name: "SUPABASE_ACCESS_TOKEN", value: "sbp_madeup" });
    await expect(setSetupToken(ctx, { id: "alice" }, { name: "STRIPE_SECRET_KEY", value: "sk" })).rejects.toThrow(
      /not a setup token/,
    );
    const { tokens } = await setupStatus(ctx);
    expect(tokens[1]).toMatchObject({ name: "SUPABASE_ACCESS_TOKEN", status: "set", source: "stored", setBy: "alice" });

    const page = await (await get("/setup/connect?github=connected")).text();
    const text = page.replaceAll("<!-- -->", "");
    expect(text).toContain("<code>sanoma-acme</code>");
    expect(text).toContain(`href="https://github.com/apps/sanoma-acme/installations/new"`);
    expect(text).toContain("The GitHub App is created and its keys are stored.");
    expect(text).toMatch(/<code>SUPABASE_ACCESS_TOKEN<\/code>.*?>set<.*?set by alice/);
    expect(text).toMatch(/<code>GITHUB_TOKEN<\/code>.*?>missing</);
    // Go live, in the sidebar, leads to the Go live page, whose first step this is.
    expect(page).toMatch(/<a [^>]*href="\/setup"[^>]*>(?:(?!<\/a>)[\s\S])*<span>Go live<\/span>/);
    for (const value of ["sbp_madeup", KEYS.client_secret, KEYS.webhook_secret, "made-up"]) {
      expect(page).not.toContain(value);
    }
  });
});
