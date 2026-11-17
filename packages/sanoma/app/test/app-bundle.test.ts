import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppBundle } from "sanoma/app";
import { buildAppBundle, NodeOnlyImport } from "sanoma/app/bundle";
import { prepareBetterAuth, prepareBetterAuthStaff } from "sanoma/better-auth";
import { testDatabaseUrl } from "sanoma/testing";
import { collection } from "sanoma/data";
import { defineConfig, ROUTER_SECRET_HEADER, SanomaClient, sealInvite } from "sanoma/workflows";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import fixture from "./fixtures/company-sites/sanoma.config.ts";
import { CLAUDE_CODE, CLAUDE_CODE_DOCUMENT, resetStaffSchema } from "./staff-oauth-helpers.ts";

// The app bundle (`buildAppBundle`) of the fixture company, built and run on workerd (Miniflare)
// over Postgres, behind a router standing in for the Cloudflare connector's: it hands the bundle
// a host that counts the worker's starts. The staff sign-in (Better Auth's, by invite) and the
// members site's login run on the Worker too. Needs Postgres (`pnpm db:up`) and the built
// packages, as sites-build.test.ts.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const databaseUrl = testDatabaseUrl("app_bundle");
const DOMAINS: Record<string, string> = { hello: "hello.example", intl: "intl.example", members: "members.example" };
const HOSTNAME = "app.example";
/** A Worker's own URL, as the Cloudflare host binds it (`SANOMA_HOST_URL`): where one declared without a hostname answers. */
const WORKERS_DEV = "https://sanoma-app-test.acme.workers.dev";
delete process.env.NODE_PATH;

/** The connector's part, in the test: the bundle's fetch with a host that counts the worker's starts. */
const ROUTER = `import app from "./index.js";
let started = 0;
const host = { startNow: async () => void started++ };
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test/started") return new Response(String(started));
    return app.fetch(request, env, ctx, host);
  },
};
`;

/**
 * Where an answer of the provider's sends the browser: a redirect's location, or, for a request it
 * takes for a page's own fetch (as Miniflare's dispatch says it is), the `url` of its JSON.
 */
async function nextOf(response: Response): Promise<string> {
  if (response.status === 302) return response.headers.get("location")!;
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string }).url;
}

/** Writes `content` to `file`, making its folder. */
function write(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A declared client whose document redirects to Claude Code's: the Worker must not follow it. */
const MOVED = "https://claude.ai/oauth/moved";

/** The one declared person, whom the staff login admits (by invite here), and the agent Claude Code stands for. */
const PEOPLE = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", email: "ada@acme.test" });
export const claudeCode = sanoma.agent({ id: "claude-code", client: "${CLAUDE_CODE}" });
export const moved = sanoma.agent({ id: "moved", client: "${MOVED}" });
`;

/** The agents' router the Worker serves on one more hostname (`config.router`), its secret, and the one company it lists. */
const ROUTER_HOSTNAME = "mcp.example";
const ROUTER_SECRET = "the-router's-secret";
const LISTED = "https://acme-instance.example";
/** A token that names a company, signed by nobody: all the router reads of one. */
const tagged = (id: string) => `e30.${Buffer.from(JSON.stringify({ sanoma_company: id })).toString("base64url")}.c2ln`;
/** What the router forwarded to the listed company, as that company's stand-in saw it. */
const forwarded: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];

/**
 * Each URL the Worker fetched: none but Claude Code's document, which a stand-in for claude.ai
 * answers, and what its router forwards to the company it lists, which a stand-in answers too.
 */
const outbound: string[] = [];
const claudeAi = async (request: Request): Promise<Response> => {
  if (request.url.startsWith(`${LISTED}/`)) {
    forwarded.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, { headers: { "set-cookie": "sid=1" } });
  }
  outbound.push(request.url);
  if (request.url === MOVED) return new Response(null, { status: 302, headers: { location: CLAUDE_CODE } });
  return request.url === CLAUDE_CODE ? Response.json(CLAUDE_CODE_DOCUMENT) : new Response("Not found", { status: 404 });
};

/**
 * A workflow file the config does not list, on a schedule: the Worker's config has it as `sanoma`
 * loads the config, and checks its schedule with DBOS's cron parser.
 */
const NIGHTLY = `import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "nightly",
  title: "Tidy up nightly",
  trigger: { schedule: "0 3 * * *" },
  input: z.object({}),
  uses: [],
  run: async () => ({ tidied: "nightly" }),
});
`;

/**
 * A workflow file that renders an invoice: the bundle carries it for its declarations, and the PDF
 * renderer it loads at a render is left out (`OPTIONAL`), as for a company that never installed it.
 */
const INVOICE = `import { defineWorkflow, z } from "sanoma";
import { invoiceSchema } from "sanoma/invoices";
import { renderInvoice } from "sanoma/invoices/pdf";

export default defineWorkflow({
  name: "render-invoice",
  title: "Render an invoice",
  trigger: "manual",
  input: z.object({ invoice: invoiceSchema }),
  uses: [],
  run: async (_ctx, { invoice }) => (await renderInvoice(invoice)).filename,
});
`;

/** A component of the members site that calls `api`, on a click. */
const GREET = `import { api } from "sanoma/site";

export function Greet() {
  return (
    <button type="button" onClick={() => void api.hello.start({ who: "a member" })}>
      Greet a member
    </button>
  );
}
`;

/** A page of the members site that makes no call itself, and imports one that does (`GREET`). */
const GREET_PAGE = `import { createFileRoute } from "@tanstack/react-router";
import { Greet } from "../components/greet.tsx";

export const Route = createFileRoute("/sites/members/greet")({ component: Greet });
`;

/** A copy of the fixture company, with the app installed as a company installs it, one person declared, workflow files, and a members page importing a component that calls. */
function company(): { repo: string; config: ReturnType<typeof defineConfig> } {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-bundle-"));
  temporary.push(repo);
  cpSync(fixtureDir, repo, { recursive: true });
  write(join(repo, "resources", "people.ts"), PEOPLE);
  write(join(repo, "workflows", "nightly.ts"), NIGHTLY);
  write(join(repo, "workflows", "render-invoice.ts"), INVOICE);
  write(join(repo, "sites", "members", "components", "greet.tsx"), GREET);
  write(join(repo, "sites", "members", "routes", "greet.tsx"), GREET_PAGE);
  // The agents' router, on a hostname of its own, over a collection that lists the companies.
  appendFileSync(join(repo, "resources", "data.ts"), COMPANIES);
  const configFile = join(repo, "sanoma.config.ts");
  write(
    configFile,
    readFileSync(configFile, "utf8").replace("collections: [leads],", `collections: [leads],\n  ${ROUTED}`),
  );
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(join(appDir, ".."), join(repo, "node_modules", "sanoma"));
  return {
    repo,
    config: defineConfig({
      ...fixture,
      collections: [...(fixture.collections ?? []), companies],
      router,
      root: repo,
      file: configFile,
      databaseUrl,
    }),
  };
}

/** The collection the router's companies are records of, as the copy's `resources/data.ts` declares it, and the config's `router`. */
const COMPANIES = `\nexport const companies = collection({ name: "companies", key: "slug", fields: { slug: "text", url: "text" } });\n`;
const companies = collection({ name: "companies", key: "slug", fields: { slug: "text", url: "text" } });
const router = { hostname: ROUTER_HOSTNAME, companies: { collection: "companies" } };
const ROUTED = `router: ${JSON.stringify(router)},`;

const temporary: string[] = [];
let bundle: AppBundle;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
/** The same upload with no DATABASE binding, so the app cannot be made: what answers there needs no app. */
let appless: Awaited<ReturnType<typeof unstable_startWorker>>;
/** The same upload declared without a hostname: no `SANOMA_HOSTNAME`, its own URL in `SANOMA_HOST_URL`. */
let unnamed: Awaited<ReturnType<typeof unstable_startWorker>>;

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const get: Fetch = (url, init) => worker.fetch(url, init as never) as unknown as Promise<Response>;
/** Requests to a Worker as TLS in front of it hands them on (the dev server is plain http): an invite's URL and a cookie are then https's. */
const through =
  (to: () => Worker): Fetch =>
  (url, init = {}) =>
    to().fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "x-forwarded-proto": "https" },
    } as never) as unknown as Promise<Response>;
const secure = through(() => worker);

/** `tools/list` at `app`'s `/mcp`, as an MCP client posts it, with `headers`. */
const listTools = (fetch: Fetch, app: string, headers: Record<string, string>) =>
  fetch(`${app}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

/** What going live does at `app`: an invite for Ada from a request sealed under the signing key, landed, then the link that signs her in. Her session's cookie. */
async function signInByInvite(fetch: Fetch, app: string): Promise<string> {
  const minted = await fetch(`${app}/auth/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: sealInvite({ email: "ada@acme.test" }) }),
  });
  expect(minted.status).toBe(200);
  const { url } = (await minted.json()) as { url: string };
  expect(url).toMatch(new RegExp(`^${app}/auth/invite/`));
  const landing = await fetch(url);
  expect(landing.status).toBe(200);
  const html = await landing.text();
  expect(html).toContain("Continue as ada@acme.test");
  const verify = /href="([^"]*magic-link\/verify[^"]*)"/.exec(html)?.[1]?.replaceAll(/&(?:amp|#38);/g, "&");
  expect(verify).toBeDefined();
  const landed = await fetch(`${app}${verify}`, { redirect: "manual" });
  expect(landed.status).toBe(302);
  expect(landed.headers.get("location")).toBe(`${app}/`);
  const cookie = landed.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toMatch(/session_token=/);
  return cookie!;
}

const CLIENT_REDIRECT = "http://127.0.0.1:53682/callback";

/** `client`'s authorize at `app` for its `/mcp`, opened in the browser of the person signed in with `cookie`. */
const authorize = (fetch: Fetch, app: string, cookie: string, client: string, verifier: string) =>
  fetch(
    `${app}/auth/better-auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "s1",
      resource: `${app}/mcp`,
    })}`,
    { headers: { cookie, accept: "text/html" }, redirect: "manual" },
  );

/**
 * Claude Code's sign-in at `app` for the person signed in with `cookie`: authorize, her consent,
 * the token endpoint's form with no Origin. Its access token's claims, and the redirect back.
 */
async function connectClient(fetch: Fetch, app: string, cookie: string) {
  const verifier = randomBytes(32).toString("base64url");
  const asked = await authorize(fetch, app, cookie, CLAUDE_CODE, verifier);
  const consentAt = new URL(await nextOf(asked), app);
  expect(consentAt.pathname).toBe("/auth/consent");
  expect(await (await fetch(consentAt.href, { headers: { cookie } })).text()).toContain("Let claude-code act for you?");
  const allowed = await fetch(`${app}/auth/better-auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app, cookie },
    body: JSON.stringify({ accept: true, oauth_query: consentAt.search.slice(1) }),
  });
  const back = new URL(((await allowed.json()) as { url: string }).url);
  const exchanged = await fetch(`${app}/auth/better-auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLAUDE_CODE,
      code_verifier: verifier,
      resource: `${app}/mcp`,
    }).toString(),
  });
  expect(exchanged.status).toBe(200);
  const { access_token } = (await exchanged.json()) as { access_token: string };
  const claims = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
  return { access_token, claims, back };
}

beforeAll(async () => {
  const { repo, config } = company();
  bundle = await buildAppBundle(repo, { config, domains: DOMAINS });
  // What the worker does at its start: the database and the logins' tables prepared (the Worker never prepares them).
  const client = await SanomaClient.connect(config);
  await client.secrets(["SANOMA_NOTHING"]);
  await client.close();
  // The one company the router lists, as a record of the collection its config names.
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(
    `INSERT INTO sanoma_data (collection, key, record, updated_by) VALUES ('companies', 'acme', $1, 'ada')
     ON CONFLICT (collection, key) DO UPDATE SET record = EXCLUDED.record`,
    [JSON.stringify({ slug: "acme", url: LISTED })],
  );
  await db.end();
  // The staff login's tables afresh: a consent an earlier run gave would skip the consent page.
  await resetStaffSchema(databaseUrl);
  await Promise.all([prepareBetterAuth(databaseUrl), prepareBetterAuthStaff(databaseUrl)]);
  const dir = mkdtempSync(join(tmpdir(), "sanoma-bundle-upload-"));
  temporary.push(dir);
  for (const { name, content } of bundle.modules) write(join(dir, "script", name), Buffer.from(content, "base64"));
  for (const { path, content } of bundle.assets) write(join(dir, "assets", path), Buffer.from(content, "base64"));
  write(join(dir, "script", "router.js"), ROUTER);
  /** The upload as Cloudflare runs it: the router the main module, the bundle's modules beside it, the assets bound. */
  const start = (file: string, vars: Record<string, unknown>) => {
    write(
      join(dir, file),
      JSON.stringify({
        name: "sanoma-app-test",
        main: "script/router.js",
        compatibility_date: bundle.compatibilityDate,
        compatibility_flags: bundle.compatibilityFlags,
        no_bundle: true,
        rules: [
          { type: "ESModule", globs: ["**/*.js"] },
          { type: "CompiledWasm", globs: ["**/*.wasm"] },
        ],
        assets: {
          directory: "assets",
          binding: "ASSETS",
          // The client build straight from the assets; every other path the Worker's.
          run_worker_first: ["/*", "!/assets/*"],
          html_handling: "none",
          not_found_handling: "none",
        },
        vars,
      }),
    );
    return unstable_startWorker({
      config: join(dir, file),
      dev: {
        server: { hostname: "127.0.0.1", port: 0 },
        // The Worker's `fetch` (a client's metadata document), answered here: nothing leaves the machine.
        outboundService: claudeAi,
        // The Worker's own URL as Cloudflare gives it, https: wrangler's dev proxy otherwise
        // rewrites a request's `Origin` to http, which no page on the app's https host sends.
        origin: { secure: true },
        inspector: false,
        persist: false,
        watch: false,
        logLevel: "error",
      },
    });
  };
  const vars = {
    SANOMA_HOSTNAME: HOSTNAME,
    SANOMA_DOMAINS: Object.entries(DOMAINS)
      .map(([site, domain]) => `${site}=${domain}`)
      .join(","),
    // The worker's secrets, which the Worker's bindings carry: the client checks the stored
    // secrets' key, and the logins' cookies and the invite requests are signed under the signing key.
    SANOMA_SECRETS_KEY: process.env.SANOMA_SECRETS_KEY,
    SANOMA_SIGNING_KEY: process.env.SANOMA_SIGNING_KEY,
    // What the config's router forwards with.
    SANOMA_ROUTER_SECRET: ROUTER_SECRET,
  };
  const { SANOMA_HOSTNAME: _hostname, ...withoutHostname } = vars;
  [worker, appless, unnamed] = await Promise.all([
    start("wrangler.json", { ...vars, DATABASE: { connectionString: databaseUrl } }),
    start("wrangler-appless.json", vars),
    start("wrangler-unnamed.json", {
      ...withoutHostname,
      SANOMA_HOST_URL: `${WORKERS_DEV}/`,
      DATABASE: { connectionString: databaseUrl },
    }),
  ]);
  await Promise.all([worker.ready, appless.ready, unnamed.ready]);
}, 300_000);

afterAll(async () => {
  await Promise.all([worker?.dispose(), appless?.dispose(), unnamed?.dispose()]);
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("buildAppBundle", () => {
  it("prerenders the pages no call is made from of the public sites on a domain, with a login or not", () => {
    // hello's calling component is leads' alone; members has a login, and its greet imports a call;
    // every page of intl, in each language.
    expect(bundle.prerendered.map(({ asset }) => asset).toSorted()).toEqual([
      "/__sanoma/pages/hello.example/index.html",
      "/__sanoma/pages/hello.example/posts/hello/index.html",
      "/__sanoma/pages/hello.example/posts/index.html",
      "/__sanoma/pages/intl.example/fr/index.html",
      "/__sanoma/pages/intl.example/fr/posts/hello/index.html",
      "/__sanoma/pages/intl.example/index.html",
      "/__sanoma/pages/intl.example/posts/hello/index.html",
      "/__sanoma/pages/members.example/index.html",
    ]);
    const paths = new Set(bundle.assets.map(({ path }) => path));
    for (const { asset } of bundle.prerendered) expect(paths).toContain(asset);
  });

  it("names its main module, a module of its own that loads the app on the first request, and hashes each asset", () => {
    const main = bundle.modules.find(({ name }) => name === bundle.mainModule);
    expect(main).toBeDefined();
    // The isolate starts with this module alone: the app is a chunk it imports on the first request.
    expect(Buffer.from(main!.content, "base64").length).toBeLessThan(2_000);
    for (const asset of bundle.assets) {
      expect(asset.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(asset.size).toBe(Buffer.from(asset.content, "base64").length);
    }
    expect(bundle.compatibilityFlags).toContain("nodejs_compat");
    expect(bundle.version).toMatch(/\S/);
  });

  it("leaves out the worker's steps: the chat's agents, going live, connecting a repository", () => {
    for (const { name, type, content } of bundle.modules) {
      if (type !== "esm") continue;
      // Each of `steps/`'s, by a text only it has.
      expect(Buffer.from(content, "base64").toString(), name).not.toMatch(
        /setup\/connect-existing|Go live: declare the repository|"\.agent-runs"|@ai-sdk\/harness|@agentclientprotocol/,
      );
    }
  });

  it("carries only what its main module reaches, by its static and dynamic imports", () => {
    const code = new Map(
      bundle.modules.flatMap(({ name, type, content }) =>
        type === "esm" ? [[name, Buffer.from(content, "base64").toString()] as const] : [],
      ),
    );
    const reached = new Set<string>();
    const reach = (name: string) => {
      const text = code.get(name);
      if (text === undefined || reached.has(name)) return;
      reached.add(name);
      for (const [, path] of text.matchAll(/\b(?:from|import)\s*\(?\s*"(\.\.?\/[^"]+\.js)"/g)) {
        reach(posix.join(posix.dirname(name), path!));
      }
    };
    reach(bundle.mainModule);
    // The runtime's sandbox (Cucumber, faker), imported by a function the Worker never calls, among them once.
    expect([...code.keys()].filter((name) => !reached.has(name))).toEqual([]);
  });

  it("carries the workflow files' workflows and what a connector reads of its package, as Node loads them", () => {
    const code = bundle.modules.map(({ content }) => Buffer.from(content, "base64").toString()).join("\n");
    expect(code).toContain('tidied: "nightly"');
    // Only package.json says it.
    expect(code).toContain("Fixture login");
    // A workflow that renders an invoice, without the PDF renderer (`OPTIONAL`).
    expect(code).toContain("Render an invoice");
    // React-pdf's standard fonts, which only its code names.
    expect(code).not.toContain("Courier-BoldOblique");
  });

  it("answers /healthz", async () => {
    expect(await (await get(`https://${HOSTNAME}/healthz`)).text()).toBe("ok\n");
  });

  it("answers a prerendered page from the Worker's assets", async () => {
    const response = await get("https://intl.example/fr");
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    expect(await response.text()).toContain("Bienvenue sur le site intl");
    // With a query, which the page may read: rendered, not the page as built.
    const queried = await get("https://intl.example/fr?ref=mail");
    expect(queried.headers.get("etag")).toBeNull();
    expect(await queried.text()).toContain("Bienvenue sur le site intl");
  });

  it("answers a prerendered page without the app, which a Worker with no database cannot make", async () => {
    const page = (await appless.fetch("https://intl.example/fr")) as unknown as Response;
    expect([page.status, await page.text()]).toEqual([200, expect.stringContaining("Bienvenue sur le site intl")]);
    expect(((await appless.fetch(`https://${HOSTNAME}/healthz`)) as unknown as Response).status).toBe(500);
  });

  it("serves the client build straight from the Worker's assets, for a page to hydrate", async () => {
    const script = bundle.assets.find(({ path }) => path.startsWith("/assets/") && path.endsWith(".js"));
    expect(script).toBeDefined();
    const response = await get(`https://hello.example${script!.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe(Buffer.from(script!.content, "base64").toString());
  });

  it("serves a site's public files from the Worker's assets: at its domain's root to anyone, under /sites/<name>/ behind the staff sign-in", async () => {
    for (const [name, type] of [
      ["mount.js", /^text\/javascript/],
      ["demo.css", /^text\/css/],
      ["pixel.png", /^image\/png$/],
    ] as const) {
      // Among the assets as the build left them: the trim of the Worker's modules does not reach them.
      const asset = bundle.assets.find(({ path }) => path === `/sites/hello/demo/${name}`);
      expect(asset, name).toBeDefined();
      const response = await get(`https://hello.example/demo/${name}`);
      expect([response.status, response.headers.get("content-type")], name).toEqual([200, expect.stringMatching(type)]);
      expect(Buffer.from(await response.arrayBuffer()), name).toEqual(Buffer.from(asset!.content, "base64"));
    }
    // On the app's host only for a person signed in, as the site's pages are there.
    expect((await secure(`https://${HOSTNAME}/sites/hello/demo/mount.js`)).status).toBe(401);
    // Nothing under /sites/ on a site's own host, however the path is written, nor another site's at its root.
    for (const path of [
      "/sites/hello/demo/mount.js",
      "/%73ites/hello/demo/mount.js",
      "/..%2Fhello/demo/mount.js",
      "/demo/mount.js",
    ]) {
      expect((await get(`https://intl.example${path}`)).status, path).toBe(404);
    }
  });

  it("renders a page on the Worker, and its robots.txt", async () => {
    const page = await get("https://hello.example/run");
    expect([page.status, page.headers.get("etag")]).toEqual([200, null]);
    expect(await page.text()).toContain("Greet someone");
    expect(await (await get("https://hello.example/robots.txt")).text()).toContain(
      "Sitemap: https://hello.example/sitemap.xml",
    );
  });

  it("starts a run as the visitor: queued under the bundle's version, and the worker started", async () => {
    const before = Number(await (await get("https://hello.example/__test/started")).text());
    const text = await (await get("https://hello.example/started")).text();
    const runId = /Started ([\w-]+)/.exec(text)?.[1];
    expect(runId, text.slice(0, 2000)).toBeDefined();
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      const { rows } = await db.query(
        "SELECT status, queue_name, application_version FROM dbos.workflow_status WHERE workflow_uuid = $1",
        [runId],
      );
      expect(rows).toEqual([
        { status: "ENQUEUED", queue_name: "sanoma:company-sites", application_version: bundle.version },
      ]);
    } finally {
      await db.end();
    }
    expect(Number(await (await get("https://hello.example/__test/started")).text())).toBe(before + 1);
  });

  it("signs a declared person in on the Worker: an invite minted by a sealed request, landed, then the app", async () => {
    const app = `https://${HOSTNAME}`;
    // Nobody signed in: the sign-in page, which offers an invite link since the fixture names no sender.
    const signedOut = await secure(`${app}/`);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toContain("invite link");
    expect((await secure(`${app}/auth/better-auth/get-session`)).status).toBe(200);
    expect((await secure(`${app}/auth/invite/nothing`)).status).toBe(410);
    const cookie = await signInByInvite(secure, app);
    const home = await secure(`${app}/`, { headers: { cookie } });
    expect(home.status).toBe(200);
    // The agent surface (`/mcp`) on the Worker: behind the staff sign-in, then the MCP server, as the person.
    const list = (headers: Record<string, string>) => listTools(secure, app, headers);
    expect((await list({})).status).toBe(401);
    // The loopback login's header is no sign-in on a host.
    expect((await list({ "x-sanoma-actor": "ada" })).status).toBe(401);
    const listed = await list({ cookie });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('"name":"start_run"');

    // A client of her own (Claude Code) on the Worker: the 401 that starts its sign-in, the
    // metadata, authorize for her (signed in already), her consent, the token endpoint's form
    // with no Origin, and its token at /mcp as the declared agent for her.
    const challenged = await list({});
    const metadataUrl = `${app}/.well-known/oauth-protected-resource/mcp`;
    expect(challenged.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${metadataUrl}"`);
    expect(await (await secure(metadataUrl)).json()).toMatchObject({
      resource: `${app}/mcp`,
      authorization_servers: [`${app}/auth/better-auth`],
    });
    const server = (await (
      await secure(`${app}/.well-known/oauth-authorization-server/auth/better-auth`)
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      // The Worker's agent address is its `SANOMA_HOSTNAME`'s: the issuer and its endpoints there.
      issuer: `${app}/auth/better-auth`,
      token_endpoint: `${app}/auth/better-auth/oauth2/token`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
    expect(server.token_endpoint_auth_methods_supported).toContain("none");
    const { access_token, claims } = await connectClient(secure, app, cookie);
    expect(claims).toMatchObject({ aud: `${app}/mcp`, azp: CLAUDE_CODE });
    const asClient = await list({ authorization: `Bearer ${access_token}` });
    expect(asClient.status).toBe(200);
    expect(await asClient.text()).toContain('"name":"start_run"');
    expect(outbound).toEqual([CLAUDE_CODE]);
    // A client no agent declares: refused at authorize, its document never fetched.
    const undeclared = await authorize(
      secure,
      app,
      cookie,
      "https://elsewhere.example/oauth/client.json",
      "v".repeat(43),
    );
    expect(undeclared.status).toBe(403);
    expect(await undeclared.text()).toContain("resources/people.ts");
    expect(outbound).toEqual([CLAUDE_CODE]);
    // A declared client whose document redirects: refused, the redirect never followed.
    const redirected = await authorize(secure, app, cookie, MOVED, "v".repeat(43));
    expect([302, 200]).not.toContain(redirected.status);
    expect(outbound).toEqual([CLAUDE_CODE, MOVED]);
  });

  it("takes its agent address from its own URL when it has no hostname: discovery names it, and a client signs in", async () => {
    const app = WORKERS_DEV;
    const at = through(() => unnamed);
    // The 401 and both documents name the Worker's own URL, its trailing slash gone.
    const metadataUrl = `${app}/.well-known/oauth-protected-resource/mcp`;
    const challenged = await listTools(at, app, {});
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${metadataUrl}"`);
    expect(await (await at(metadataUrl)).json()).toMatchObject({
      resource: `${app}/mcp`,
      authorization_servers: [`${app}/auth/better-auth`],
    });
    expect(await (await at(`${app}/.well-known/oauth-authorization-server/auth/better-auth`)).json()).toMatchObject({
      issuer: `${app}/auth/better-auth`,
      authorization_endpoint: `${app}/auth/better-auth/oauth2/authorize`,
      token_endpoint: `${app}/auth/better-auth/oauth2/token`,
    });
    // The person signs in by an invite, then the client's sign-in for her, as on the Worker with a hostname.
    const cookie = await signInByInvite(at, app);
    const { access_token, claims, back } = await connectClient(at, app, cookie);
    expect(back.searchParams.get("iss")).toBe(`${app}/auth/better-auth`);
    expect(claims).toMatchObject({ iss: `${app}/auth/better-auth`, aud: `${app}/mcp`, azp: CLAUDE_CODE });
    const asClient = await listTools(at, app, { authorization: `Bearer ${access_token}` });
    expect(asClient.status).toBe(200);
    expect(await asClient.text()).toContain('"name":"start_run"');
    // The token is that address's: the Worker with a hostname, on the same tables and keys, refuses it.
    const elsewhere = await listTools(secure, `https://${HOSTNAME}`, { authorization: `Bearer ${access_token}` });
    expect(elsewhere.status).toBe(401);
  });

  it("answers a page of a site with a login from the assets, whoever asks, and renders one that imports a call on each request", async () => {
    // The fixture login's session cookie: a signed-in visitor gets the file anyone gets.
    for (const headers of [{}, { cookie: "x-fixture-visitor=ada" }]) {
      const page = await get("https://members.example/", { headers });
      expect([page.status, page.headers.get("etag")]).toEqual([200, expect.any(String)]);
      expect(await page.text()).toContain("For members");
    }
    const greet = await get("https://members.example/greet", { headers: { cookie: "x-fixture-visitor=ada" } });
    expect([greet.status, greet.headers.get("etag")]).toEqual([200, null]);
    expect(await greet.text()).toContain("Greet a member");
  });

  it("serves a site with a login on the Worker, its half made on the request's client", async () => {
    // The half's own route, on its site's host alone: the fixture login's sign-out clears its cookie.
    const signOut = await get("https://members.example/auth/fixture-login/sign-out", { method: "POST" });
    expect([signOut.status, signOut.headers.get("set-cookie")]).toEqual([204, "x-fixture-visitor=; Max-Age=0; Path=/"]);
    expect((await get("https://hello.example/auth/fixture-login/sign-out", { method: "POST" })).status).toBe(404);
  });

  it("answers 404 for a host that is neither the app's nor a site's domain", async () => {
    expect((await get("https://elsewhere.example/")).status).toBe(404);
  });

  it("answers its router's hostname with the router alone: its metadata, and a /mcp call sent on to the company the token names", async () => {
    const at = `https://${ROUTER_HOSTNAME}`;
    expect(await (await get(`${at}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
      issuer: at,
      authorization_endpoint: `${at}/authorize`,
      token_endpoint: `${at}/token`,
    });
    // Nothing of the app is there: no page, no probe, no sign-in.
    for (const path of ["/", "/healthz", "/auth/login"]) expect((await get(`${at}${path}`)).status, path).toBe(404);
    const challenged = await listTools(get, at, {});
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${at}/.well-known/oauth-protected-resource/mcp"`,
    );
    // A token that names the listed company, read and not checked: the company's own sign-in does that.
    const bearer = `Bearer ${tagged("acme")}`;
    const answered = await listTools(get, at, { authorization: bearer, cookie: "sanoma.session_token=x" });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(answered.headers.has("set-cookie")).toBe(false);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      url: `${LISTED}/mcp`,
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json", [ROUTER_SECRET_HEADER]: ROUTER_SECRET },
    });
    expect(forwarded[0]!.headers).not.toHaveProperty("cookie");
    expect(JSON.parse(forwarded[0]!.body)).toMatchObject({ method: "tools/list" });
    // A company it does not list is refused here, and nothing is sent.
    const unknown = await listTools(get, at, { authorization: `Bearer ${tagged("initech")}` });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token"/);
    expect(forwarded).toHaveLength(1);
  });

  it("refuses a company file importing what the Worker does not have, by file and symbol", async () => {
    const { repo, config } = company();
    write(
      join(repo, "sites", "hello", "routes", "spawn.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { execFile } from "node:child_process";

const run = createServerFn().handler(() => new Promise((done) => execFile("true", () => done("ran"))));
export const Route = createFileRoute("/sites/hello/spawn")({ loader: () => run(), component: () => null });
`,
    );
    const refused = await buildAppBundle(repo, { config }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(NodeOnlyImport);
    expect(refused).toMatchObject({
      file: "sites/hello/routes/spawn.tsx",
      symbol: "execFile",
      module: "node:child_process",
    });
  }, 300_000);

  it("refuses a company file that throws as the Worker evaluates it, naming the file and line", async () => {
    const { repo, config } = company();
    // Node has the file; the Worker, whose files are its modules, does not.
    write(join(repo, "workflows", "notes.txt"), "remember\n");
    write(
      join(repo, "workflows", "notes.ts"),
      `import { readFileSync } from "node:fs";
import { defineWorkflow, z } from "sanoma";

const notes = readFileSync(new URL("./notes.txt", import.meta.url), "utf8");

export default defineWorkflow({
  name: "notes",
  title: "Notes",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => ({ notes }),
});
`,
    );
    const refused = await buildAppBundle(repo, { config }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message.split("\n")[0]).toMatch(
      /^workflows\/notes\.ts:4 throws as the Cloudflare Worker evaluates it: Error: no such file or directory/,
    );
  }, 300_000);
});
