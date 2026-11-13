import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { github as githubConnector } from "@sanoma-ai/connector-github";
import { resend } from "@sanoma-ai/connector-resend";
import { cloud } from "@sanoma-ai/connector-sanoma-cloud";
import { supabase } from "@sanoma-ai/connector-supabase";
import { neon } from "@sanoma-ai/connector-neon";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { testDatabaseUrl, withFake } from "sanoma/testing";
import { fakeHost } from "sanoma/testing/host";
import {
  defineConfig,
  defineConnector,
  defineResource,
  LOGIN_AGENT,
  LOGIN_CODE_WORKFLOW,
  resolveConfig,
  SanomaClient,
  sealLoginCode,
  startWorker,
} from "sanoma/workflows";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { credentials, databaseOn } from "sanoma/workflows/db";
import { GO_LIVE_HOST_WORKFLOW } from "sanoma/workflows/shared";
import { secret } from "sanoma/resources";
import { eq, inArray } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type App, startApp } from "../src/index.ts";
import { noWakeup } from "../src/api.ts";
import type { AppContext } from "../src/context.ts";
import { loopbackLogin } from "../src/loopback.ts";
import { admitting } from "../src/login/admission.ts";
import { ensureSanomaBuilt } from "../../test/fixture.ts";
import { barLink } from "./bar-helpers.ts";
import { callApi } from "../src/server/core.ts";
import { appSnapshot } from "../src/snapshot-build.ts";
import { GITHUB_APP, githubManifest, mintWakeupToken, setSetupToken, setupStatus } from "../src/server/setup.ts";

// Connecting GitHub and the vendors (/hosting/connect): the GitHub App's manifest page, its callback
// against a GitHub of msw handlers, the keys stored encrypted, and the status the page shows.
// Needs Postgres and the built app, as app.test.ts does.

/** The template a new company starts from, which declares Sanoma Cloud. */
const TEMPLATE = fileURLToPath(new URL("../../template/", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "sanoma-setup-"));
// Declared, so storing the App's keys admits who asked.
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "people.ts"),
  'import { sanoma } from "sanoma/resources";\n\nexport const alice = sanoma.person({ id: "alice", email: "alice@acme.test" });\n',
);
const config = defineConfig({
  workflows: [],
  connectors: [supabase, githubConnector],
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
  // A key that signs, since the status asks GitHub for the App's listing as the App.
  pem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string,
  owner: { login: "acme" },
};
const conversions: string[] = [];
/** What GitHub lists for the App the manifest makes: a write where read was asked covers it. */
const LISTED = {
  administration: "write",
  contents: "write",
  emails: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
};
const github = setupServer(
  // Each App's listing, as the App (its JWT names it): the one the callback stores has every
  // permission the manifest asks for; App 1 was made before the manifest asked for most; for App
  // 2, GitHub does not answer.
  http.get("https://api.github.com/app", ({ request }) => {
    const jwt = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const { iss } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as { iss?: string };
    if (iss === String(KEYS.id)) return HttpResponse.json({ permissions: LISTED });
    if (iss === "1") return HttpResponse.json({ permissions: { contents: "write", metadata: "read" } });
    return HttpResponse.json({ message: "down" }, { status: 503 });
  }),
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
  "RESEND_API_KEY",
  "SANOMA_CLOUD_TOKEN",
];
let app: App;
let client: SanomaClient;
let ctx: AppContext;

beforeAll(async () => {
  vi.stubEnv("SANOMA_SIGNING_KEY", KEY);
  for (const name of NAMES) vi.stubEnv(name, "");
  github.listen({ onUnhandledFrame: "bypass" });
  ensureSanomaBuilt();
  app = await startApp(config, { port: 0 });
  client = await SanomaClient.connect(config);
  ctx = {
    resolved: resolveConfig(config),
    snapshot: await appSnapshot(config),
    client,
    place: "this-computer",
    login: admitting(loopbackLogin(), () => ({ people: [], problems: [] })),
  };
  // The table outlives a run of the tests. (Reading prepares the database; rows stored under
  // another key fail to read, and are deleted all the same.)
  await client.secrets(NAMES).catch(() => undefined);
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  await databaseOn(db)
    .delete(credentials)
    .where(inArray(credentials.name, [...NAMES]));
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
    expect(manifest).toEqual(githubManifest(app.url, `Sanoma ${ctx.snapshot.description.name}`));
    expect(manifest).toMatchObject({
      redirect_url: `${app.url}/setup/github/callback`,
      callback_urls: [`${app.url}/auth/better-auth/callback/github`],
      public: false,
      default_permissions: {
        administration: "write",
        contents: "write",
        emails: "read",
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

describe("sign-in on the host", () => {
  it("names the public sites with a login, whose visitors the App's client lets sign in with GitHub", async () => {
    // Only what setupStatus reads of each entry.
    const sites = [
      { name: "www", public: true, login: "better-auth" },
      { name: "docs", public: true },
      { name: "ops" },
    ];
    const withSites = {
      ...ctx,
      snapshot: { ...ctx.snapshot, description: { ...ctx.snapshot.description, sites } },
    } as unknown as AppContext;
    expect((await setupStatus(withSites)).signIn.sites).toEqual([{ name: "www", login: "better-auth" }]);
  });

  it("holds the stored App to the manifest's permissions, by GitHub's listing of it, or says GitHub did not", async () => {
    expect((await setupStatus(ctx)).githubApp?.missing).toEqual([]);
    // Each case is another App: the listing is kept a while by slug.
    try {
      await client.setSecret(GITHUB_APP.slug, "lacking", { by: "alice" });
      await client.setSecret(GITHUB_APP.id, "1", { by: "alice" });
      expect((await setupStatus(ctx)).githubApp?.missing).toEqual([
        "administration: write",
        "emails: read",
        "pull_requests: write",
        "statuses: write",
      ]);
      await client.setSecret(GITHUB_APP.slug, "down", { by: "alice" });
      await client.setSecret(GITHUB_APP.id, "2", { by: "alice" });
      expect((await setupStatus(ctx)).githubApp?.missing).toBeNull();
    } finally {
      await client.setSecret(GITHUB_APP.slug, KEYS.slug, { by: "alice" });
      await client.setSecret(GITHUB_APP.id, String(KEYS.id), { by: "alice" });
    }
  });

  it("names the config's sender, connected once its connector's credentials are stored", async () => {
    const withSender = defineConfig({
      ...config,
      connectors: [supabase, resend],
      login: { sender: resend.emails.send, from: "Acme <login@acme.test>" },
    });
    const sendingClient = await SanomaClient.connect(withSender);
    const sending = { ...ctx, resolved: resolveConfig(withSender), client: sendingClient };
    try {
      expect((await setupStatus(sending)).signIn).toMatchObject({
        sender: "resend.emails.send",
        senderConnected: false,
      });
      await sendingClient.setCredential("RESEND_API_KEY", "re_madeup", { by: "alice" });
      expect((await setupStatus(sending)).signIn).toMatchObject({
        sender: "resend.emails.send",
        senderConnected: true,
      });
    } finally {
      await sendingClient.clearCredential("RESEND_API_KEY", { by: "alice" });
      await sendingClient.close();
    }
  });
});

describe("the connect page", () => {
  it("says what is connected, and stores a pasted token, never showing a value", async () => {
    expect(await setupStatus(ctx)).toEqual({
      githubApp: { slug: KEYS.slug, setBy: "alice", setAt: expect.any(String), missing: [] },
      tokens: [
        // Supabase's connector declares its own accounts (its connector page): no pasted token here.
        expect.objectContaining({ name: "GITHUB_TOKEN", status: "missing" }),
      ],
      // The App's client is stored (the callback above): GitHub sign-in on the host.
      signIn: { you: null, sender: null, senderConnected: false, github: true, sites: [] },
    });
    expect((await setupStatus(ctx, { id: "alice" })).signIn.you).toBe("alice@acme.test");
    await setSetupToken(ctx, { id: "alice" }, { name: "GITHUB_TOKEN", value: "ghp_madeup" });
    for (const name of ["STRIPE_SECRET_KEY", "SUPABASE_ACCESS_TOKEN"])
      await expect(setSetupToken(ctx, { id: "alice" }, { name, value: "sk" })).rejects.toThrow(/not a setup token/);
    const { tokens } = await setupStatus(ctx);
    expect(tokens[0]).toMatchObject({ name: "GITHUB_TOKEN", status: "set", source: "stored", setBy: "alice" });

    // An old link to /setup/connect goes on to Hosting's Connect page.
    expect((await get("/setup/connect?github=connected")).headers.get("location")).toBe(
      "/hosting/connect?github=connected",
    );
    const page = await (await get("/hosting/connect?github=connected")).text();
    const text = page.replaceAll("<!-- -->", "");
    expect(text).toContain("<code>sanoma-acme</code>");
    expect(text).toContain(`href="https://github.com/apps/sanoma-acme/installations/new"`);
    expect(text).toContain("The GitHub App is created and its keys are stored.");
    expect(text).toMatch(/<code>GITHUB_TOKEN<\/code>.*?>set<.*?set by alice/);
    expect(text).not.toContain("SUPABASE_ACCESS_TOKEN");
    // Hosting, in the bar, is lit: going live is its state while nothing is declared to run on.
    expect(barLink(page, "/hosting")).toContain('data-active="true"');
    for (const value of ["ghp_madeup", KEYS.client_secret, KEYS.webhook_secret, "made-up"]) {
      expect(page).not.toContain(value);
    }
    // A value of ?github= the callback never sends is no outcome: the page without it.
    const odd = await get("/hosting/connect?github=bogus");
    expect(odd.status).toBe(307);
    expect(odd.headers.get("location")).toBe("/hosting/connect");
  });
});

describe("a control plane's enrollment writer", () => {
  it("is an item of the connect page until its URL is stored, never showing the value", async () => {
    const writer = "IDENTITY_WRITER_URL";
    const plane: AppContext = {
      ...ctx,
      resolved: resolveConfig(defineConfig({ ...config, identityProvisioning: { databaseUrl: secret(writer) } })),
    };
    expect((await setupStatus(ctx)).enrollmentWriter).toBeUndefined();
    const before = await setupStatus(plane);
    expect(before.enrollmentWriter).toBe(writer);
    expect(before.tokens.at(-1)).toMatchObject({ name: writer, status: "missing", optional: false });
    await expect(setSetupToken(ctx, { id: "alice" }, { name: writer, value: "x" })).rejects.toThrow(
      /not a setup token/,
    );
    const url = "postgresql://writer:made-up-password@db.example.test/identity";
    try {
      await setSetupToken(plane, { id: "alice" }, { name: writer, value: url });
      const after = await setupStatus(plane);
      expect(after.tokens.at(-1)).toMatchObject({ name: writer, status: "set", setBy: "alice" });
      expect(JSON.stringify(after)).not.toContain("made-up-password");
    } finally {
      await client.clearSecret(writer, { by: "alice" });
    }
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
      await databaseOn(db).delete(credentials).where(eq(credentials.name, "SANOMA_WAKEUP_TOKEN"));
      await db.end();
    }
  });

  it("is asked for only when the config declares a host, and mints the instance's token beside the account's", async () => {
    // No host type (the config above): no wakeup rows, and its tokens are refused.
    expect((await setupStatus(ctx)).tokens.map((t) => t.name)).toEqual(["GITHUB_TOKEN"]);
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
      expect((await setupStatus(ops)).tokens.slice(1)).toEqual([
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
  it("does not offer or accept a global token for a connector with named authentication", async () => {
    const declared = { ...config, connectors: [neon] };
    const named = { ...ctx, resolved: resolveConfig(declared) };
    expect((await setupStatus(named)).tokens.some((token) => token.name === "NEON_API_KEY")).toBe(false);
    await expect(setSetupToken(named, { id: "alice" }, { name: "NEON_API_KEY", value: "synthetic" })).rejects.toThrow(
      "not a setup token",
    );
  });

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

describe("Connect Sanoma Cloud", () => {
  it("asks for a Cloud token where the config has the Cloud connector, and stores only one that is a Cloud token", async () => {
    const declared = defineConfig({ ...config, connectors: [githubConnector, cloud] });
    const clouded: AppContext = { ...ctx, resolved: resolveConfig(declared) };
    expect((await setupStatus(clouded)).tokens).toContainEqual(
      expect.objectContaining({ name: "SANOMA_CLOUD_TOKEN", status: "missing" }),
    );
    expect((await setupStatus(ctx)).tokens.some((token) => token.name === "SANOMA_CLOUD_TOKEN")).toBe(false);
    await expect(
      setSetupToken(clouded, { id: "alice" }, { name: "SANOMA_CLOUD_TOKEN", value: "ghp_not-cloud" }),
    ).rejects.toThrow("That is not a Cloud token: one starts with sca_");
    await setSetupToken(clouded, { id: "alice" }, { name: "SANOMA_CLOUD_TOKEN", value: "sca_pasted-token" });
    const status = await setupStatus(clouded);
    expect(status.tokens).toContainEqual(
      expect.objectContaining({ name: "SANOMA_CLOUD_TOKEN", status: "set", source: "stored", setBy: "alice" }),
    );
    expect(JSON.stringify(status)).not.toContain("sca_pasted-token");
    // Signed out again, for Hosting's tests below.
    await client.clearSecret("SANOMA_CLOUD_TOKEN", { by: "alice" });
  });
});

/** A page of an app, as the browser gets it from the server: React's text separators left out. */
const html = async (path: string, url = app.url) =>
  (await (await fetch(new URL(path, url))).text()).replaceAll("<!-- -->", "");

/** Going live's Sign-in item on Hosting: from its heading to step 2's. */
async function signInItem() {
  const page = await html("/hosting");
  return page.slice(page.indexOf(">Sign-in<"), page.indexOf(">2. Choose where it goes</h2>"));
}

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
    // Her open card links to her declaration on Hosting.
    expect(await html("/people?person=alice")).toContain('href="/hosting?resource=resources%2Fpeople.ts%23alice"');
  });

  it("says how people will sign in on the host, as the Go live board draws it, with the ways to fix a missing email code", async () => {
    // No App to begin with (an earlier test may have stored one).
    const db = new Client({ connectionString: config.databaseUrl });
    await db.connect();
    await databaseOn(db)
      .delete(credentials)
      .where(inArray(credentials.name, Object.values(GITHUB_APP)));
    await db.end();
    // No sender and no App: the email code warns, not blocking, with both ways to fix it.
    const bare = await signInItem();
    expect(bare).toContain(">invite links only<");
    expect(bare).toContain("declare your email in the people file to be signed in on the host when it first answers");
    expect(bare).toContain("no sender yet, name one in <code>sanoma.config.ts</code>");
    expect(bare).toContain(">warning · not blocking<");
    expect(bare).toContain(">Two ways to fix it</h3>");
    expect(bare).toContain("login: { sender: resend.emails.send");
    expect(bare).toContain("Codes then go to the emails declared in <code>resources/people.ts</code>.");
    expect(bare).toMatch(
      /Or connect the GitHub App on <a[^>]*href="\/hosting\/connect"[^>]*>Hosting › Connect<\/a>: people declared with a GitHub login can use Continue with GitHub\./,
    );
    expect(bare).not.toContain(">GitHub</span> · the company");
    // The App's client stored: GitHub is a way in, and naming a sender is the one fix left.
    await client.setSecret(GITHUB_APP.client_id, KEYS.client_id, { by: "alice" });
    await client.setSecret(GITHUB_APP.client_secret, KEYS.client_secret, { by: "alice" });
    const withApp = await signInItem();
    expect(withApp).toContain(">ready<");
    expect(withApp).toContain(">GitHub</span> · the company&#x27;s App");
    expect(withApp).toContain(">How to fix it</h3>");
    expect(withApp).toContain(">warning · not blocking<");
    expect(withApp).not.toContain("Or connect the GitHub App");
  });

  it("puts the repository the host clones, the database and the host in cards, every other resource under Other resources, and going live's steps until the host is bound", async () => {
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
      // The fake host is long-lived: always on, and no Wakeup asked for.
      expect(card("Host")).toMatch(/>Lifetime<.*?>Always on</s);
      expect(card("Host")).not.toContain("No connected wakeup");
      // The other repository under Other resources; no people. Declared is not live: nothing is
      // bound, so the company is Local and going live's steps show, on accounts of its own.
      expect(page).toContain(">Other resources</h2>");
      expect(page).toContain('href="/hosting?resource=resources%2Fsanoma%2Finfra.ts%23docs"');
      expect(page).not.toContain("resources%2Fpeople.ts%23alice");
      expect(page).toContain(">1. Connect</h2>");
      expect(page).not.toContain(">Ready to go live</h2>");
      expect(page).toContain(">Local</span>");
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
    }
    // The host bound: Live, and this computer's copy is the drafting copy; going live is done.
    writeFileSync(
      join(live, "resources", "sanoma.lock.json"),
      JSON.stringify({
        "resources/sanoma/infra.ts#repo": { type: "github.repository", id: "R_kgDOrepo0001" },
        "resources/sanoma/infra.ts#host": { type: "testhost.app", id: "acme-ops" },
      }),
    );
    const bound = await startApp(
      defineConfig({ ...config, connectors: [githubConnector, supabase, host.connector], root: live }),
      { port: 0 },
    );
    try {
      const page = await html("/hosting", bound.url);
      expect(page).not.toContain(">1. Connect</h2>");
      expect(page).toContain(">Live · drafting copy</span>");
      expect(page).toContain("Live · drafting copy: the company runs online");
      expect(page).toContain("<h2>Host</h2>");
    } finally {
      await bound.close();
      rmSync(live, { recursive: true, force: true });
    }
  });

  it("is ready to go live where the template declares Sanoma Cloud and nothing is bound, with going live on the company's own accounts a link away", async () => {
    const local = mkdtempSync(join(tmpdir(), "sanoma-hosting-"));
    mkdirSync(join(local, "resources", "sanoma"), { recursive: true });
    writeFileSync(
      join(local, "resources", "sanoma", "infra.ts"),
      readFileSync(join(TEMPLATE, "resources", "sanoma", "infra.ts"), "utf8").replaceAll("company", "acme"),
    );
    writeFileSync(join(local, "resources", "people.ts"), readFileSync(join(root, "resources", "people.ts")));
    const started = await startApp(defineConfig({ ...config, connectors: [githubConnector, cloud], root: local }), {
      port: 0,
    });
    try {
      const page = await html("/hosting", started.url);
      expect(page).toContain(">Local</span>");
      expect(page).toContain(">Ready to go live</h2>");
      // Its address, the slug infra.ts declares, to check or change; not signed in, Go live signs in first.
      expect(page).toMatch(/<input[^>]*id="go-live-address"[^>]*value="acme"/);
      expect(page).toContain(">.sanoma.work</span>");
      expect(page).toContain("Not signed in: Go live opens Sanoma in your browser first");
      expect(page).toMatch(/>Go live<\/button>/);
      expect(page).toContain('href="/hosting/connect"');
      expect(page).toContain('href="/hosting?own=true"');
      expect(page).not.toContain(">1. Connect</h2>");
      // The declared database and host in their cards, unbound, the host's address once applied.
      expect(page).toMatch(/<h2>Host<\/h2>(?:(?!<h2>)[\s\S])*>acme\.sanoma\.work<.*?once applied/s);
      const own = await html("/hosting?own=true", started.url);
      expect(own).toContain(">1. Connect</h2>");
      expect(own).not.toContain(">Ready to go live</h2>");
      // Home's last step is not done: the company is not online.
      expect(await html("/", started.url)).toMatch(/>[1-4] of 5 done</);
    } finally {
      await started.close();
      rmSync(local, { recursive: true, force: true });
    }
  });

  it("says going live while its run goes on, and Go live failed, with Retry and Ask the agent, once it failed", async () => {
    const going = defineConfig({ ...config, databaseUrl: testDatabaseUrl("setup_state") });
    const started = await startApp(going, { port: 0 });
    const runs = await SanomaClient.connect(going);
    try {
      // Queued, no worker to take it: going live.
      const runId = await runs.start(GO_LIVE_HOST_WORKFLOW, {}, { startedBy: { id: "alice" } });
      const deploying = await html("/hosting", started.url);
      expect(deploying).toContain(">Going live…</span>");
      expect(deploying).toContain(">Going live</h2>");
      expect(deploying).toContain(">The repository<");
      expect(deploying).toMatch(/Going live is <span[^>]*>.*?queued/s);
      // A worker without the app's steps fails it: going live failed, and why.
      const worker = await startWorker(going);
      try {
        await runs.result(runId).catch(() => undefined);
      } finally {
        await worker.stop();
      }
      const failed = await html("/hosting", started.url);
      expect(failed).toContain(">Go live failed</span>");
      expect(failed).toContain(">Go live failed</h2>");
      expect(failed).toMatch(/>Retry</);
      expect(failed).toContain(">Ask the agent<");
      expect(failed).not.toContain(">1. Connect</h2>");
    } finally {
      await runs.close();
      await started.close();
    }
  });

  it("says a host that stops when idle does, and that nothing starts it again while no Wakeup names it", async () => {
    const host = fakeHost(() => Promise.reject(new Error("not started here")), { lifetime: "stops-on-exit" });
    /** The Host card's text with infra.ts declaring the repository, the host and then `more`. */
    const hostCard = async (more = "") => {
      const live = mkdtempSync(join(tmpdir(), "sanoma-hosting-"));
      mkdirSync(join(live, "resources", "sanoma"), { recursive: true });
      writeFileSync(
        join(live, "resources", "sanoma", "infra.ts"),
        `import { github } from "@sanoma-ai/connector-github/resources";
import { testhost } from "@sanoma-ai/testing-host/resources";
import { sanoma } from "sanoma/resources";

export const repo = github.repository({ owner: "acme", name: "acme-ops", visibility: "private" });
export const host = testhost.app({ name: "acme-ops", source: repo, ref: "main", port: 8080 });
${more}`,
      );
      const hosted = await startApp(
        defineConfig({ ...config, connectors: [githubConnector, host.connector], root: live }),
        { port: 0 },
      );
      try {
        return (await html("/hosting", hosted.url)).match(/<h2>Host<\/h2>(?:(?!<h2>)[\s\S])*/)?.[0];
      } finally {
        await hosted.close();
        rmSync(live, { recursive: true, force: true });
      }
    };
    const card = await hostCard();
    expect(card).toMatch(/>Lifetime<.*?>Stops when idle</s);
    expect(card).not.toContain("started by the Wakeup");
    expect(card).toContain(`${noWakeup("testhost.app")}.`);
    expect(card).not.toMatch(/scale to zero|cold start|alarm/i);
    // A Wakeup for another host starts this one no more than none.
    const other = await hostCard(
      `export const other = testhost.app({ name: "other", source: repo, ref: "main", port: 8081 });
export const wakeup = sanoma.wakeup({ host: other });
`,
    );
    expect(other).not.toContain("started by the Wakeup");
    expect(other).toContain(`${noWakeup("testhost.app")}.`);
    const woken = await hostCard("export const wakeup = sanoma.wakeup({ host });\n");
    expect(woken).toMatch(/>Lifetime<.*?>Stops when idle; what is due while it is stopped is started by the Wakeup</s);
    expect(woken).not.toContain("No connected wakeup");
  });
});

describe("a sign-in code's run", () => {
  it("shows its input as fields, the code sealed, and the mail's body redacted, never the sealed code or the code, on its page or to an api read", async () => {
    // On a database of its own, with a worker that runs the code's mail on Resend's fake.
    const mailer = withFake(resend, fakeResend());
    const sending = defineConfig({
      ...config,
      connectors: [mailer],
      login: { sender: mailer.emails.send, from: "Acme <login@acme.test>" },
      databaseUrl: testDatabaseUrl("setup_login_code"),
    });
    const worker = await startWorker(sending);
    const started = await startApp(sending, { port: 0 });
    const runs = await SanomaClient.connect(sending);
    try {
      const sealed = sealLoginCode("alice@acme.test", "246810");
      const runId = await runs.start(
        LOGIN_CODE_WORKFLOW,
        { to: "alice@acme.test", code: sealed },
        { startedBy: LOGIN_AGENT },
      );
      await runs.result(runId);
      const page = await html(`/workflows/${LOGIN_CODE_WORKFLOW}/runs/${runId}`, started.url);
      expect(page).toContain(`Started by ${LOGIN_AGENT}`);
      expect(page).toContain(`sealed · <code class="text-xs">${sealed.slice(0, 4)}…</code>`);
      expect(page).toContain("codes never enter the ledger");
      expect(page).toMatch(/&quot;text&quot;: <span[^>]*>redacted<\/span>/);
      expect(page).not.toContain("&quot;&lt;text&gt;&quot;");
      expect(page).not.toContain(sealed);
      expect(page).not.toContain("246810");
      // A site's api read of the run's ledger is sent no more of the sealed code than the page.
      const read = { ...ctx, resolved: resolveConfig(sending), snapshot: await appSnapshot(sending), client: runs };
      const ledger = JSON.stringify(
        await callApi(read, { id: "alice" }, { name: "loginCode.ledger", input: { runId } }),
      );
      expect(ledger).toContain(`"code":"${sealed.slice(0, 4)}"`);
      expect(ledger).not.toContain(sealed);
    } finally {
      await runs.close();
      await started.close();
      await worker.stop();
    }
  });
});
