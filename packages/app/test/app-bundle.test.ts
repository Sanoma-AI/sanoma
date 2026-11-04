import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AppBundle, buildAppBundle, NodeOnlyImport, prerenderedPages } from "@sanoma-ai/app/bundle";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, SanomaClient } from "@sanoma-ai/workflows";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import fixture from "./fixtures/company-sites/sanoma.config.ts";

// The app bundle (`buildAppBundle`) of the fixture company, built and run on workerd (Miniflare)
// over Postgres, behind a router standing in for the Cloudflare connector's: it hands the bundle
// a host that counts the worker's starts. Needs Postgres (`pnpm db:up`) and the built packages,
// as sites-build.test.ts.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const databaseUrl = testDatabaseUrl("app_bundle");
const DOMAINS: Record<string, string> = { hello: "hello.example", intl: "intl.example", members: "members.example" };
const HOSTNAME = "app.example";
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

/** Writes `content` to `file`, making its folder. */
function write(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A copy of the fixture company, with the app installed as a company installs it. */
function company(): { repo: string; config: ReturnType<typeof defineConfig> } {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-bundle-"));
  temporary.push(repo);
  cpSync(fixtureDir, repo, { recursive: true });
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(join(appDir, "..", "sanoma"), join(repo, "node_modules", "sanoma"));
  return { repo, config: defineConfig({ ...fixture, root: repo, file: join(repo, "sanoma.config.ts"), databaseUrl }) };
}

const temporary: string[] = [];
let bundle: AppBundle;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

const get = (url: string, init?: RequestInit) => worker.fetch(url, init as never) as unknown as Promise<Response>;

beforeAll(async () => {
  const { repo, config } = company();
  bundle = await buildAppBundle(repo, { config, domains: DOMAINS });
  // What the worker does at its start: the database prepared (the Worker never prepares it).
  const client = await SanomaClient.connect(config);
  await client.secrets(["SANOMA_NOTHING"]);
  await client.close();
  const dir = mkdtempSync(join(tmpdir(), "sanoma-bundle-upload-"));
  temporary.push(dir);
  for (const { name, content } of bundle.modules) write(join(dir, "script", name), Buffer.from(content, "base64"));
  for (const { path, content } of bundle.assets) write(join(dir, "assets", path), Buffer.from(content, "base64"));
  write(join(dir, "script", "router.js"), ROUTER);
  // As Cloudflare runs the upload: the router the main module, the bundle's modules beside it, the assets bound.
  write(
    join(dir, "wrangler.json"),
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
      vars: {
        DATABASE: { connectionString: databaseUrl },
        SANOMA_HOSTNAME: HOSTNAME,
        SANOMA_DOMAINS: Object.entries(DOMAINS)
          .map(([site, domain]) => `${site}=${domain}`)
          .join(","),
        // The worker's secrets, which the Worker's bindings carry: the client checks the stored secrets' key.
        SANOMA_SECRETS_KEY: process.env.SANOMA_SECRETS_KEY,
      },
    }),
  );
  worker = await unstable_startWorker({
    config: join(dir, "wrangler.json"),
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      logLevel: "error",
    },
  });
  await worker.ready;
}, 300_000);

afterAll(async () => {
  await worker?.dispose();
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A site's page at `path`, and a call made from `page` (none: from a file that is no page). */
const pageAt = (path: string) => ({ path });
const callFrom = (page?: string) => ({
  kind: "workflow" as const,
  target: "hello",
  via: "api" as const,
  file: "sites/www/routes/index.tsx",
  line: 1,
  column: 1,
  ...(page && { page }),
});

describe("prerenderedPages", () => {
  it("leaves out the pages a call is made from, on the page or a layout above it", () => {
    const pages = [
      pageAt("/sites/www"),
      pageAt("/sites/www/form"),
      pageAt("/sites/www/shop"),
      pageAt("/sites/www/shop/cart"),
    ];
    expect(prerenderedPages({ pages, calls: [callFrom("/sites/www/form"), callFrom("/sites/www/shop")] })).toEqual([
      pageAt("/sites/www"),
    ]);
  });

  it("prerenders nothing when a call is made from a file that is no page", () => {
    expect(prerenderedPages({ pages: [pageAt("/sites/www")], calls: [callFrom()] })).toEqual([]);
  });
});

describe("buildAppBundle", () => {
  it("prerenders the pages no call is made from, of the public sites with no login on a domain", () => {
    // hello's component calls `api`, so none of hello's; every page of intl, in each language.
    expect(bundle.prerendered.map(({ asset }) => asset).toSorted()).toEqual([
      "/__sanoma/pages/intl.example/fr/index.html",
      "/__sanoma/pages/intl.example/fr/posts/hello/index.html",
      "/__sanoma/pages/intl.example/index.html",
      "/__sanoma/pages/intl.example/posts/hello/index.html",
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

  it("leaves out what needs the checkout: the coding agents, going live, connecting a repository", () => {
    for (const { name, type, content } of bundle.modules) {
      if (type !== "esm") continue;
      // Each of `server/local/`'s and `server/agent/`'s, by a text only it has.
      expect(Buffer.from(content, "base64").toString(), name).not.toMatch(
        /setup\/connect-existing|"\.agent-runs"|@ai-sdk\/harness|@agentclientprotocol/,
      );
    }
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

  it("serves the client build straight from the Worker's assets, for a page to hydrate", async () => {
    const script = bundle.assets.find(({ path }) => path.startsWith("/assets/") && path.endsWith(".js"));
    expect(script).toBeDefined();
    const response = await get(`https://hello.example${script!.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe(Buffer.from(script!.content, "base64").toString());
  });

  it("renders a page on the Worker, and its robots.txt", async () => {
    expect(await (await get("https://hello.example/")).text()).toContain("Hello from the hello site");
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

  it("answers 503 for the staff's pages and a site with a login, whose sign-in is not on the Worker yet", async () => {
    for (const url of [`https://${HOSTNAME}/`, `https://${HOSTNAME}/_serverFn/x`, "https://members.example/"]) {
      expect((await get(url)).status, url).toBe(503);
    }
  });

  it("answers 404 for a host that is neither the app's nor a site's domain", async () => {
    expect((await get("https://elsewhere.example/")).status).toBe(404);
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
});
