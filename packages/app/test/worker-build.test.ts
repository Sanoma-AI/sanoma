import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorker, prerenderedPages, WORKER_FUNCTIONS, type WorkerBundle } from "@sanoma-ai/app/build";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, readRootSnapshot, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { PUBLIC_FNS } from "../src/middleware.ts";
import fixture from "./fixtures/company-sites/sanoma.config.ts";

// The sites bundle (`buildWorker`) of the fixture company, built and run on workerd (Miniflare)
// over Postgres, behind a router standing in for the Cloudflare connector's: it records the
// container's starts and answers for the container. Needs Postgres (`pnpm db:up`) and the built
// packages, as sites-build.test.ts.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const databaseUrl = testDatabaseUrl("worker_build");
const DOMAINS: Record<string, string> = { hello: "hello.example", intl: "intl.example", members: "members.example" };
delete process.env.NODE_PATH;

/** The connector's part, in the test: the container's starts counted, and the container's answer its path. */
const ROUTER = `import sites from "./index.js";
let started = 0;
const host = {
  startNow: async () => void started++,
  fetch: async (request) => new Response("container " + new URL(request.url).pathname, { headers: { "x-container": "1" } }),
};
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test/started") return new Response(String(started));
    return sites.serves(request, env) ? sites.fetch(request, env, ctx, host) : host.fetch(request);
  },
};
`;

/** Writes `content` to `file`, making its folder. */
function write(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const temporary: string[] = [];
let bundle: WorkerBundle | undefined;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

const get = (url: string, init?: RequestInit) => worker.fetch(url, init as never) as unknown as Promise<Response>;

beforeAll(async () => {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-worker-"));
  temporary.push(repo);
  cpSync(fixtureDir, repo, { recursive: true });
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(join(appDir, "..", "sanoma"), join(repo, "node_modules", "sanoma"));
  const config = defineConfig({ ...fixture, root: repo, file: join(repo, "sanoma.config.ts"), databaseUrl });
  const resolved = resolveConfig(config);
  const described = describeConfig(config);
  const description = {
    ...described,
    sites: described.sites.map((site) => ({ ...site, ...(DOMAINS[site.name] && { domain: DOMAINS[site.name] }) })),
  };
  bundle = await buildWorker(repo, {
    configFile: config.file!,
    description,
    snapshot: readRootSnapshot(config, resolved),
  });
  // What the container does at its start: the database prepared (the Worker never prepares it).
  const client = await SanomaClient.connect(config);
  await client.secrets(["SANOMA_NOTHING"]);
  await client.close();
  const dir = mkdtempSync(join(tmpdir(), "sanoma-worker-bundle-"));
  temporary.push(dir);
  for (const { name, content } of bundle!.modules) write(join(dir, "script", name), Buffer.from(content, "base64"));
  for (const { path, content } of bundle!.assets) write(join(dir, "assets", path), Buffer.from(content, "base64"));
  write(join(dir, "script", "router.js"), ROUTER);
  // As Cloudflare runs the upload: the router the main module, the bundle's modules beside it, the assets bound.
  write(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "sanoma-sites-test",
      main: "script/router.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      no_bundle: true,
      rules: [
        { type: "ESModule", globs: ["**/*.js"] },
        { type: "CompiledWasm", globs: ["**/*.wasm"] },
      ],
      assets: {
        directory: "assets",
        binding: "ASSETS",
        // As the connector uploads them (`ASSETS_CONFIG`): the client build straight from the assets.
        run_worker_first: ["/*", "!/assets/*"],
        html_handling: "none",
        not_found_handling: "none",
      },
      vars: {
        SANOMA_DOMAINS: Object.entries(DOMAINS)
          .map(([site, domain]) => `${site}=${domain}`)
          .join(","),
        SANOMA_DATABASE_URL: databaseUrl,
        // The container's secrets, which the Worker's bindings carry: the client checks the stored secrets' key.
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

describe("buildWorker", () => {
  it("serves the public sites on a domain with no login, and prerenders the pages no call is made from", () => {
    expect(bundle?.sites).toEqual(["hello", "intl"]);
    const pages = bundle!.assets.map(({ path }) => path).filter((path) => path.startsWith("/__sanoma/"));
    // hello's component calls `api`, so none of hello's; every page of intl, in each language.
    expect(pages).toEqual([
      "/__sanoma/sites/intl/fr/index.html",
      "/__sanoma/sites/intl/fr/posts/hello/index.html",
      "/__sanoma/sites/intl/index.html",
      "/__sanoma/sites/intl/posts/hello/index.html",
    ]);
    expect(bundle!.modules.map(({ name }) => name)).toContain(bundle!.mainModule);
  });

  it("answers a prerendered page from the Worker's assets", async () => {
    const response = await get("https://intl.example/fr");
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    expect(await response.text()).toContain("Bienvenue sur le site intl");
  });

  it("serves the client build straight from the Worker's assets, for a page to hydrate", async () => {
    const script = bundle!.assets.find(({ path }) => path.startsWith("/assets/") && path.endsWith(".js"));
    expect(script).toBeDefined();
    const response = await get(`https://hello.example${script!.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe(Buffer.from(script!.content, "base64").toString());
  });

  it("renders a page on the Worker, and its robots.txt", async () => {
    const response = await get("https://hello.example/");
    expect(response.headers.get("x-container")).toBeNull();
    expect(await response.text()).toContain("Hello from the hello site");
    expect(await (await get("https://hello.example/robots.txt")).text()).toContain(
      "Sitemap: https://hello.example/sitemap.xml",
    );
  });

  it("starts a run as the visitor: queued for the container's worker, and the container started", async () => {
    const before = Number(await (await get("https://hello.example/__test/started")).text());
    const text = await (await get("https://hello.example/started")).text();
    const runId = /Started ([\w-]+)/.exec(text)?.[1];
    expect(runId, text.slice(0, 2000)).toBeDefined();
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      const { rows } = await db.query("SELECT status, queue_name FROM dbos.workflow_status WHERE workflow_uuid = $1", [
        runId,
      ]);
      expect(rows).toEqual([{ status: "ENQUEUED", queue_name: "sanoma:company-sites" }]);
    } finally {
      await db.end();
    }
    expect(Number(await (await get("https://hello.example/__test/started")).text())).toBe(before + 1);
  });

  it("answers the server functions a public site's host answers, as the container does", () => {
    expect(WORKER_FUNCTIONS).toEqual(PUBLIC_FNS);
  });

  it("leaves the container a site with a login, the app's paths and any other host", async () => {
    for (const url of ["https://members.example/", "https://hello.example/api/runs", "https://app.example/"]) {
      expect(await (await get(url)).text()).toBe(`container ${new URL(url).pathname}`);
    }
  });
});
