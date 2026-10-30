import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { github as githubConnector } from "@sanoma-ai/connector-github";
import { supabase } from "@sanoma-ai/connector-supabase";
import { ensureBuilt, testDatabaseUrl } from "@sanoma-ai/testing";
import { fakeHost } from "@sanoma-ai/testing/host";
import { defineConfig, defineConnector, defineResource, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type App, startApp } from "../src/index.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { barLink } from "./bar-helpers.ts";
import { GITHUB_APP, githubManifest, mintWakeupToken, setSetupToken, setupStatus } from "../src/server/setup.ts";

// Connecting GitHub and the vendors (/hosting/connect): the GitHub App's manifest page, its callback
// against a GitHub of msw handlers, the keys stored encrypted, and the status the page shows.
// Needs Postgres and the built app, as app.test.ts does.

const appDir = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "sanoma-setup-"));
// Declared, so storing the App's keys admits who asked.
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  'import { sanoma } from "sanoma/resources";\n\nexport const alice = sanoma.person({ id: "alice" });\n',
);
const config = defineConfig({
  workflows: [],
  connectors: [supabase],
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
const NAMES = [
  ...Object.values(GITHUB_APP),
  "GITHUB_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "NEON_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "SANOMA_WAKEUP_URL",
  "SANOMA_WAKEUP_ACCOUNT_TOKEN",
  "SANOMA_WAKEUP_TOKEN",
];
let app: App;
let client: SanomaClient;
let ctx: AppContext;

beforeAll(async () => {
  vi.stubEnv("SANOMA_SIGNING_KEY", KEY);
  for (const name of NAMES) vi.stubEnv(name, "");
  github.listen({ onUnhandledFrame: "bypass" });
  ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
  app = await startApp(config, { port: 0 });
  client = await SanomaClient.connect(config);
  ctx = {
    resolved: resolveConfig(config),
    description: describeConfig(config),
    client,
    place: "this-computer",
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

/** Who asks, as the loopback login's cookie names her. */
const AS_ALICE = "sanoma_actor=alice";
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
    const res = await get("/setup/github/manifest", AS_ALICE);
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
      default_permissions: {
        administration: "write",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "write",
      },
      default_events: ["push", "pull_request"],
      // On this machine, which GitHub cannot reach: off.
      hook_attributes: { url: `${app.url}/webhooks/github`, active: false },
    });
    expect(githubManifest("https://acme.example", "Sanoma acme").hook_attributes).toEqual({
      url: "https://acme.example/webhooks/github",
      active: true,
    });
    expect(html).toContain('document.getElementById("manifest").submit()');
    const line = res.headers.getSetCookie().find((l) => l.startsWith("sanoma_setup_state="))!;
    expect(line).toMatch(/Path=\/setup\/github;.*HttpOnly/);
    // The state, who asked and the signature.
    expect(stateCookie(res)).toMatch(new RegExp(`^sanoma_setup_state=${state}\\.[\\w-]+\\.[\\w-]+$`));
  });

  it("creates it in an organization's settings, and refuses a name that is not a login", async () => {
    const { action } = form(await (await get("/setup/github/manifest?org=acme-co", AS_ALICE)).text());
    expect(`${action.origin}${action.pathname}`).toBe("https://github.com/organizations/acme-co/settings/apps/new");
    const bad = await get("/setup/github/manifest?org=acme%2F..");
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe("/hosting/connect?github=bad-org");
    // Nobody asking: the keys could be stored as no one, so GitHub is not asked.
    const nobody = await get("/setup/github/manifest");
    expect(nobody.status).toBe(303);
    expect(nobody.headers.get("location")).toBe("/hosting/connect?github=nobody");
  });

  it("refuses a callback whose state is not the cookie's, or whose cookie is not signed here, asking GitHub nothing", async () => {
    const start = await get("/setup/github/manifest", AS_ALICE);
    const cookie = stateCookie(start);
    const state = cookie.split("=")[1]!.split(".")[0]!;
    for (const [query, sent] of [
      [`code=good&state=other`, cookie],
      [`code=good&state=${state}`, `sanoma_setup_state=${state}.forged`],
      [`code=good&state=${state}`, undefined],
    ] as const) {
      const res = await get(`/setup/github/callback?${query}`, sent);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/hosting/connect?github=expired");
    }
    expect(conversions).toEqual([]);
    expect((await setupStatus(ctx)).githubApp).toBeNull();
  });

  it("says so when GitHub will not convert the code", async () => {
    const cookie = stateCookie(await get("/setup/github/manifest", AS_ALICE));
    const state = cookie.split("=")[1]!.split(".")[0]!;
    const res = await get(`/setup/github/callback?code=stale&state=${state}`, cookie);
    expect(res.headers.get("location")).toBe("/hosting/connect?github=failed");
    expect(conversions).toEqual(["stale"]);
  });

  it("exchanges the code and stores the App's keys encrypted, under their own names", async () => {
    const cookie = stateCookie(await get("/setup/github/manifest", AS_ALICE));
    const state = cookie.split("=")[1]!.split(".")[0]!;
    const res = await get(`/setup/github/callback?code=good&state=${state}`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hosting/connect?github=connected");
    // The state cookie is used once.
    expect(stateCookie(res)).toBe("sanoma_setup_state=");

    const stored = await client.secrets(Object.values(GITHUB_APP));
    expect([...stored.keys()].toSorted()).toEqual(Object.values(GITHUB_APP).toSorted());
    expect(stored.get(GITHUB_APP.client_secret)).toMatchObject({ value: KEYS.client_secret, setBy: "alice" });
    expect(stored.get(GITHUB_APP.id)?.value).toBe("4242");
    expect(stored.get(GITHUB_APP.pem)?.value).toBe(KEYS.pem);
    // Signing-key rotation does not alter credential encryption.
    vi.stubEnv("SANOMA_SIGNING_KEY", randomBytes(32).toString("base64"));
    expect((await client.secrets([GITHUB_APP.pem])).get(GITHUB_APP.pem)?.value).toBe(KEYS.pem);
    const encryptionKey = process.env.SANOMA_SECRETS_KEY;
    vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
    await expect(client.secrets([GITHUB_APP.pem])).rejects.toThrow("Secret store: invalid_value");
    vi.stubEnv("SANOMA_SECRETS_KEY", encryptionKey);
    vi.stubEnv("SANOMA_SIGNING_KEY", KEY);
  });
});

describe("the connect page", () => {
  it("says what is connected, and stores a pasted token, never showing a value", async () => {
    expect(await setupStatus(ctx)).toEqual({
      githubApp: { slug: KEYS.slug, setBy: "alice", setAt: expect.any(String) },
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

    // An old link to /setup/connect goes on to Hosting's Connect page.
    expect((await get("/setup/connect?github=connected")).headers.get("location")).toBe(
      "/hosting/connect?github=connected",
    );
    const page = await (await get("/hosting/connect?github=connected")).text();
    const text = page.replaceAll("<!-- -->", "");
    expect(text).toContain("<code>sanoma-acme</code>");
    expect(text).toContain(`href="https://github.com/apps/sanoma-acme/installations/new"`);
    expect(text).toContain("The GitHub App is created and its keys are stored.");
    expect(text).toMatch(/<code>SUPABASE_ACCESS_TOKEN<\/code>.*?>set<.*?set by alice/);
    expect(text).toMatch(/<code>GITHUB_TOKEN<\/code>.*?>missing</);
    // Hosting, in the bar, is lit: going live is its state while nothing is declared to run on.
    expect(barLink(page, "/hosting")).toContain('data-active="true"');
    for (const value of ["sbp_madeup", KEYS.client_secret, KEYS.webhook_secret, "made-up"]) {
      expect(page).not.toContain(value);
    }
    // A value of ?github= the callback never sends is no outcome: the page without it.
    const odd = await get("/hosting/connect?github=bogus");
    expect(odd.status).toBe(307);
    expect(odd.headers.get("location")).toBe("/hosting/connect");
  });
});

/** The instance's wakeup token, as stored (every client here is on the one database). */
const instanceToken = async () => (await client.secrets(["SANOMA_WAKEUP_TOKEN"])).get("SANOMA_WAKEUP_TOKEN")?.value;

describe("Connect a wakeup service", () => {
  it("mints the instance's token once, as going live does when it declares a wakeup, and again when fresh", async () => {
    const db = new Client({ connectionString: config.databaseUrl });
    try {
      await mintWakeupToken(client, { id: "alice" });
      const minted = await instanceToken();
      expect(minted).toMatch(/^swi_[\w-]{43}$/);
      await mintWakeupToken(client, { id: "alice" });
      expect(await instanceToken()).toBe(minted);
      await mintWakeupToken(client, { id: "alice" }, true);
      expect(await instanceToken()).not.toBe(minted);
    } finally {
      await db.connect();
      await db.query("DELETE FROM sanoma_credentials WHERE name = 'SANOMA_WAKEUP_TOKEN'");
      await db.end();
    }
  });

  it("is asked for only when the config declares a host, and mints the instance's token beside the account's", async () => {
    // No host type (the config above): no wakeup rows, and its tokens are refused.
    expect((await setupStatus(ctx)).tokens.map((t) => t.name)).toEqual(["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN"]);
    await expect(
      setSetupToken(ctx, { id: "alice" }, { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: `swa_${"a".repeat(43)}` }),
    ).rejects.toThrow(/not a setup token/);

    // A host type brings the runtime's own wakeup, sanoma.wakeup.
    const host = fakeHost(async () => ({ url: "", stop: async () => undefined }));
    const declared = defineConfig({ ...config, connectors: [supabase, host.connector] });
    const opsClient = await SanomaClient.connect(declared);
    try {
      const ops: AppContext = { ...ctx, resolved: resolveConfig(declared), client: opsClient };
      expect((await setupStatus(ops)).tokens).toEqual([
        expect.objectContaining({ name: "GITHUB_TOKEN" }),
        expect.objectContaining({ name: "SUPABASE_ACCESS_TOKEN" }),
        expect.objectContaining({ name: "SANOMA_WAKEUP_URL", optional: true, status: "missing" }),
        expect.objectContaining({ name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", optional: true, status: "missing" }),
      ]);
      // The driver's own checks: an account's token starts swa_.
      await expect(
        setSetupToken(ops, { id: "alice" }, { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: "not-a-token" }),
      ).rejects.toThrow(/does not match the required format/);
      expect((await opsClient.secrets(["SANOMA_WAKEUP_TOKEN"])).size).toBe(0);

      const account = `swa_${"a".repeat(43)}`;
      await setSetupToken(ops, { id: "alice" }, { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: account });
      const minted = (await opsClient.secrets(["SANOMA_WAKEUP_TOKEN"])).get("SANOMA_WAKEUP_TOKEN");
      expect(minted).toMatchObject({ value: expect.stringMatching(/^swi_[\w-]{43}$/), setBy: "alice" });
      // Stored again, the same account's: the instance keeps its token.
      await setSetupToken(ops, { id: "alice" }, { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: account });
      expect(await instanceToken()).toBe(minted!.value);
      // Another account's: a new instance token, as the old one is the old account's instance's.
      await setSetupToken(
        ops,
        { id: "alice" },
        { name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", value: `swa_${"b".repeat(43)}` },
      );
      const renewed = await instanceToken();
      expect(renewed).toMatch(/^swi_[\w-]{43}$/);
      expect(renewed).not.toBe(minted!.value);
      await setSetupToken(ops, { id: "alice" }, { name: "SANOMA_WAKEUP_URL", value: "http://127.0.0.1:4100" });
      expect((await setupStatus(ops)).tokens.slice(2)).toEqual([
        expect.objectContaining({ name: "SANOMA_WAKEUP_URL", status: "set" }),
        expect.objectContaining({ name: "SANOMA_WAKEUP_ACCOUNT_TOKEN", status: "set", setBy: "alice" }),
      ]);
      // The instance's token is never among what the page is told.
      expect(JSON.stringify(await setupStatus(ops))).not.toContain(renewed);
    } finally {
      await opsClient.close();
    }
  });
});

/** A connector of one read-only type `vendor.type`, for a config that declares the vendor. */
const typeOf = (vendor: string, type: string) =>
  defineConnector(
    vendor,
    {
      [type]: defineResource({
        vendor,
        type,
        title: type,
        schema: z.object({ name: z.string() }),
        fields: { immutable: [], vendorOwned: [], writeOnly: [] },
      }),
    },
    { package: `@acme/${vendor}` },
  );

describe("Connect Cloudflare and Neon", () => {
  it("asks for their tokens only when the config declares a type of the vendor", async () => {
    const declared = defineConfig({
      ...config,
      connectors: [typeOf("neon", "project"), typeOf("cloudflare", "container")],
    });
    const hosted: AppContext = { ...ctx, resolved: resolveConfig(declared) };
    expect((await setupStatus(hosted)).tokens).toEqual([
      expect.objectContaining({ name: "GITHUB_TOKEN" }),
      expect.objectContaining({ name: "NEON_API_KEY", optional: false, status: "missing" }),
      expect.objectContaining({ name: "CLOUDFLARE_API_TOKEN", optional: true, status: "missing" }),
      expect.objectContaining({ name: "CLOUDFLARE_ACCOUNT_ID", optional: true, status: "missing" }),
    ]);
    await expect(setSetupToken(ctx, { id: "alice" }, { name: "NEON_API_KEY", value: "napi_madeup" })).rejects.toThrow(
      /not a setup token/,
    );
  });
});

/** A page of an app, as the browser gets it from the server: React's text separators left out. */
const html = async (path: string, url = app.url) =>
  (await (await fetch(new URL(path, url))).text()).replaceAll("<!-- -->", "");

describe("Hosting", () => {
  it("shows going live's steps while no host and no database are declared, and none of the people", async () => {
    const page = await html("/hosting");
    expect(page).toMatch(/<h1[^>]*>Hosting<\/h1>/);
    expect(page).toContain(">1. Connect</h2>");
    expect(page).toContain(">2. Choose where it goes</h2>");
    expect(page).toContain('href="/hosting/connect"');
    // alice is on People, not here; nothing else is declared.
    expect(page).not.toContain("resources%2Fpeople.ts%23alice");
    expect(page).not.toContain(">Other resources</h2>");
    expect(barLink(page, "/hosting")).toContain('aria-current="page"');
    const people = await html("/people");
    expect(people).toMatch(/<h1[^>]*>People<span[^>]*>1<\/span><\/h1>/);
    expect(people).toContain('href="/hosting?resource=resources%2Fpeople.ts%23alice"');
  });

  it("puts the repository the host clones, the database and the host in cards, every other resource under Other resources, and going live again until the host is applied", async () => {
    const live = mkdtempSync(join(tmpdir(), "sanoma-hosting-"));
    mkdirSync(join(live, "resources", "sanoma"), { recursive: true });
    writeFileSync(
      join(live, "resources", "sanoma", "infra.ts"),
      `import { github } from "@sanoma-ai/connector-github/resources";
import { supabase } from "@sanoma-ai/connector-supabase/resources";
import { testhost } from "@sanoma-ai/testing-host/resources";
import { secret } from "sanoma/resources";

export const docs = github.repository({ owner: "acme", name: "acme-docs" });
export const repo = github.repository({ owner: "acme", name: "acme-ops", visibility: "private" });
export const store = supabase.project({
  name: "acme-ops",
  region: "eu-west-1",
  organization_id: "acme-org",
  database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
});
export const host = testhost.app({ name: "acme-ops", source: repo, ref: "main", port: 8080 });
`,
    );
    writeFileSync(join(live, "resources", "people.ts"), readFileSync(join(root, "resources", "people.ts")));
    const host = fakeHost(() => Promise.reject(new Error("not started here")));
    const hosted = await startApp(
      defineConfig({ ...config, connectors: [githubConnector, supabase, host.connector], root: live }),
      { port: 0 },
    );
    try {
      const page = await html("/hosting", hosted.url);
      /** A slot's card: from its heading to the next card's. */
      const card = (title: string) => page.match(new RegExp(`<h2>${title}</h2>(?:(?!<h2>)[\\s\\S])*`))?.[0];
      // The repository is the one the host clones, not the first declared.
      expect(card("Repository")).toContain(">acme/acme-ops<");
      expect(card("Repository")).toContain("github.repository");
      expect(card("Repository")).toMatch(/>visibility<.*?>private</s);
      expect(card("Database")).toContain("supabase.project");
      expect(card("Database")).toMatch(/>region<.*?>eu-west-1</s);
      expect(card("Host")).toContain("testhost.app");
      expect(card("Host")).toMatch(/>port<.*?>8080</s);
      // The other repository under Other resources; no people, and no going live.
      expect(page).toContain(">Other resources</h2>");
      expect(page).toContain('href="/hosting?resource=resources%2Fsanoma%2Finfra.ts%23docs"');
      expect(page).not.toContain("resources%2Fpeople.ts%23alice");
      expect(page).not.toContain(">1. Connect</h2>");
    } finally {
      await hosted.close();
    }
    // Going live part-way, its repository applied and its host not yet (a restart in between):
    // its steps show again, since only they push the repository and apply the host.
    writeFileSync(
      join(live, "resources", "sanoma.lock.json"),
      JSON.stringify({ "resources/sanoma/infra.ts#repo": { type: "github.repository", id: "R_kgDOrepo0001" } }),
    );
    const resumed = await startApp(
      defineConfig({ ...config, connectors: [githubConnector, supabase, host.connector], root: live }),
      { port: 0 },
    );
    try {
      const page = await html("/hosting", resumed.url);
      expect(page).toContain(">1. Connect</h2>");
      expect(page).toContain("<h2>Repository</h2>");
    } finally {
      await resumed.close();
      rmSync(live, { recursive: true, force: true });
    }
  });
});
