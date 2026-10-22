import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, sitesOf, writeSiteFiles } from "@sanoma-ai/app/build";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import {
  defineConfig,
  defineConnector,
  SanomaClient,
  startWorker,
  VISITOR_DENIED,
  type Worker,
  withSetup,
} from "@sanoma-ai/workflows";
import { describeConfig, writeApi } from "@sanoma-ai/workflows/describe";
import { executablePath, launch } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACTOR_COOKIE, ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import { loginContexts } from "./fixtures/company-sites/login.ts";
import fixture from "./fixtures/company-sites/sanoma.config.ts";

// Needs Postgres (`pnpm db:up`) and the built workflows package (the server bundle imports the
// runtime from its dist/). The one test in a browser needs Google Chrome, or `CHROME_PATH` naming
// a Chrome or Chromium binary, and skips without either.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const config = defineConfig({ ...fixture, databaseUrl: testDatabaseUrl("sites_build") });

// A company's install has no NODE_PATH, which pnpm's vitest shim sets to its hoisted packages:
// Tailwind would find `tailwindcss` there, where a company's build does not.
delete process.env.NODE_PATH;

const repos: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/**
 * A copy of the fixture company, outside this checkout, with `files` written over it. Its
 * `node_modules` holds `sanoma` alone, as a company's install does: this checkout's, whose
 * dependencies are linked beside it.
 */
function company(files: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-sites-"));
  repos.push(repo);
  cpSync(fixtureDir, repo, { recursive: true });
  mkdirSync(join(repo, "node_modules"));
  symlinkSync(join(appDir, "..", "sanoma"), join(repo, "node_modules", "sanoma"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

/** Every entry under `dir`, not following links, with its modification time: what a build must leave as it was. */
const entries = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => `${path} ${lstatSync(path).mtimeMs}`)
    .toSorted();

/** A site page at `path` that imports `line`, and shows `shown`. */
const sitePage = (
  path: string,
  line: string,
  shown: string,
) => `import { createFileRoute } from "@tanstack/react-router";
${line}

export const Route = createFileRoute("${path}")({ component: () => <div>{${shown}}</div> });
`;

/**
 * A site page that starts hello for `who` and reads a refusal without a cast, with `errorBodyOf`
 * and `ApiError` from sanoma/site, branching on `code`.
 */
const starting = (who: string, code: string) => `import { createFileRoute } from "@tanstack/react-router";
import { api, ApiError, errorBodyOf, type ErrorResponse } from "sanoma/site";

async function start(): Promise<string> {
  try {
    return (await api.hello.start({ who: ${who} })).runId;
  } catch (err) {
    const body: ErrorResponse | undefined = errorBodyOf(err);
    if (body?.code === "${code}") return \`waiting in \${body.runId}\`;
    if (err instanceof ApiError && err.status === 403) return err.body.error;
    throw err;
  }
}

export const Route = createFileRoute("/sites/hello/styled")({ loader: start, component: () => <div /> });
`;

/**
 * A request to the app with `host` as its Host, which fetch does not let a caller set, and so with
 * no need for `*.localhost` to resolve (it does not on every Linux).
 */
function rawGet(
  url: string,
  host: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { hostname, port, pathname, search } = new URL(url);
  return new Promise((done, fail) => {
    httpRequest(
      { host: hostname, port, path: pathname + search, method: init.method, headers: { ...init.headers, host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    )
      .on("error", fail)
      .end(init.body);
  });
}

/** What a browser says of a server function's request from its own page, which Start's CSRF check asks for. */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

/** The id of the server function `name` in a build, from its server entry's table of them. */
function serverFnId(distDir: string, name: string): string {
  const server = readFileSync(join(distDir, "server", "server.js"), "utf8");
  const id = new RegExp(`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`).exec(server)?.[1];
  if (!id) throw new Error(`no server function ${name} in ${distDir}`);
  return id;
}

/** The opening tag of the link around the first `text`. */
function linkTag(html: string, text: string) {
  const start = html.lastIndexOf("<a ", html.indexOf(text));
  return start < 0 ? undefined : html.slice(start, html.indexOf(">", start) + 1);
}

/** The page's region or section under the heading `title`, up to the next heading, or the page's end. */
function sectionAfter(html: string, title: string) {
  const start = html.search(new RegExp(`<h[23][^>]*>${title}</h[23]>`));
  if (start < 0) return "";
  const next = html.slice(start + 1).search(/<h[1-6][ >]|<script/);
  return next < 0 ? html.slice(start) : html.slice(start, start + 1 + next);
}

/**
 * A class only a site uses, put together here so that Tailwind, scanning this package for the
 * package's own build, does not find it in this file.
 */
const siteClass = ["tracking", "[0.37em]"].join("-");

/** `/sites/hello/styled`: the site's class, and its `sites/hello/style.css` linked from its head. */
const styledPage = `import { createFileRoute } from "@tanstack/react-router";
import css from "../style.css?url";

export const Route = createFileRoute("/sites/hello/styled")({
  head: () => ({ links: [{ rel: "stylesheet", href: css }] }),
  component: () => <span className="${siteClass}" />,
});
`;

/** The hrefs of the stylesheets a page links. */
const stylesheets = (html: string) =>
  [...html.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes('rel="stylesheet"'))
    .map((tag) => tag.match(/href="([^"]+)"/)![1]!);

describe("a company's app with its sites", () => {
  // The fixture has no .gitignore, and nor has its copy: nothing tells Tailwind to skip `.sanoma/`.
  const repo = company({
    // A site's own stylesheet, without Tailwind's preflight, linked by the page using its class.
    "sites/hello/style.css":
      '@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);\n',
    "sites/hello/routes/styled.tsx": styledPage,
    "sites/hello/routes/missing.tsx": sitePage(
      "/sites/hello/missing",
      'import { RunForm } from "sanoma/ui";',
      '<RunForm workflow="missing" />',
    ),
  });
  // And sanoma, which the company's node_modules links to.
  const untouched = {
    src: join(appDir, "src"),
    modules: join(appDir, "node_modules"),
    sanoma: join(appDir, "..", "sanoma"),
  };
  const before = { src: [] as string[], modules: [] as string[], sanoma: [] as string[] };
  let result: { distDir: string; built: boolean };
  let worker: Worker;
  let app: App;

  beforeAll(async () => {
    before.src = entries(untouched.src);
    before.modules = entries(untouched.modules);
    before.sanoma = entries(untouched.sanoma);
    result = await buildApp(repo);
    worker = await startWorker(config);
    app = await startApp(config, { port: 0, distDir: result.distDir });
  });

  afterAll(async () => {
    await app?.close();
    await worker?.stop();
  });

  it("builds into .sanoma/app with the sites in the route tree, writing nothing in the app or under node_modules", () => {
    expect(result.built).toBe(true);
    expect(result.distDir).toMatch(/[/\\]\.sanoma[/\\]app[/\\]build[/\\][0-9a-f]{16}$/);
    expect(existsSync(join(result.distDir, "server", "server.js"))).toBe(true);
    const tree = readFileSync(join(dirname(dirname(result.distDir)), "routeTree.gen.ts"), "utf8");
    expect(tree).toContain("id: '/sites/hello/'");
    expect(tree).toContain("id: '/workflows'");
    expect(entries(untouched.src)).toEqual(before.src);
    expect(entries(untouched.modules)).toEqual(before.modules);
    expect(entries(untouched.sanoma)).toEqual(before.sanoma);
    expect(readdirSync(join(repo, "node_modules"))).toEqual(["sanoma"]);
    // The route generator's temporary files, too, are under .sanoma/app, not in the cwd.
    expect(existsSync(join(repo, ".sanoma", "app", "tmp"))).toBe(true);
  });

  it("serves a site's page inside the app's shell, and the app's own pages", async () => {
    const site = await fetch(new URL("/sites/hello/", app.url));
    expect(site.status).toBe(200);
    const html = (await site.text()).replaceAll("<!-- -->", "");
    expect(html).toContain("The hello site");
    expect(html).toContain("Hello from the hello site");
    expect(html).toContain('data-slot="sidebar-wrapper"');
    const workflows = await fetch(new URL("/workflows", app.url));
    expect(workflows.status).toBe(200);
    expect(await workflows.text()).toContain("Say hello");
  });

  it("serves a site's RunForm: the workflow's fields under a link to its page, live only, or a notice naming a workflow the config lacks", async () => {
    const site = await fetch(new URL("/sites/hello/run", app.url));
    expect(site.status).toBe(200);
    const html = (await site.text()).replaceAll("<!-- -->", "");
    // The hello workflow's input, `{ who: string }`, as one required text field.
    expect(html).toMatch(/<label[^>]*for="field-who"[^>]*>who<span[^>]*>\*<\/span>/);
    expect(html).toMatch(/<input[^>]*id="field-who"[^>]*type="text"/);
    expect(linkTag(html, "Say hello")).toContain('href="/workflows/hello"');
    expect(html).toContain("Start run");
    expect(html).not.toContain("Sandbox");
    const missing = (await (await fetch(new URL("/sites/hello/missing", app.url))).text()).replaceAll("<!-- -->", "");
    expect(missing).toContain("This company has no workflow named “missing”.");
    expect(missing).not.toContain("field-");
  });

  it("starts a run from a site's RunForm and links to it there, while the app's New run opens the run's page", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const browser = await launch({ executablePath: chrome, headless: true });
    let client: SanomaClient | undefined;
    try {
      client = await SanomaClient.connect(config);
      const page = await browser.newPage();
      // A desktop window, where the New run panel shows beside the graph.
      await page.setViewport({ width: 1440, height: 900 });
      // The name the app asks for once, kept in the browser, sent with every change.
      await page.evaluateOnNewDocument(() => localStorage.setItem("sanoma.actor", "tester"));
      const site = new URL("/sites/hello/run", app.url).href;
      await page.goto(site, { waitUntil: "networkidle0" });
      await page.type("#field-who", "Ada");
      await page.click('button[type="submit"]');
      const link = await page.waitForSelector('a[href^="/workflows/hello/runs/"]::-p-text(Open the run)');
      const runId = (await link!.evaluate((a) => a.getAttribute("href")!)).split("/").at(-1)!;
      expect(page.url()).toBe(site);
      expect(await client.result(runId)).toEqual({ greeting: "hello Ada" });
      expect(await client.run(runId)).toMatchObject({ workflow: "hello", startedBy: { id: "tester" } });

      await page.goto(new URL("/workflows/hello?new=true", app.url).href, { waitUntil: "networkidle0" });
      await page.type("#field-who", "Grace");
      await page.click('button[type="submit"]');
      // A string, run in the page: this file is typed for Node, without the DOM's `location`.
      await page.waitForFunction(String.raw`/^\/workflows\/hello\/runs\/[^/]+$/.test(location.pathname)`);
    } finally {
      await client?.close();
      await browser.close();
    }
  });

  it("renders a page whose loader calls api as the person asking: the loopback login's header, else its cookie", async () => {
    const client = await SanomaClient.connect(config);
    try {
      /** What /sites/hello/started's loader answered, and who started the run it started. */
      const started = async (headers: Record<string, string>) => {
        const html = (await (await fetch(new URL("/sites/hello/started", app.url), { headers })).text()).replaceAll(
          "<!-- -->",
          "",
        );
        const said = html.match(/<p>((?:Started|Refused:) [^<]+)<\/p>/)?.[1];
        const runId = said?.match(/^Started (.+)$/)?.[1];
        return { said, by: runId && (await client.run(runId))?.startedBy };
      };
      const cookie = `${ACTOR_COOKIE}=${encodeURIComponent("Ada Lovelace")}`;
      expect(await started({ cookie })).toEqual({
        said: expect.stringMatching(/^Started /),
        by: { id: "Ada Lovelace" },
      });
      expect((await started({ cookie, [ACTOR_HEADER]: "grace" })).by).toEqual({ id: "grace" });
      expect(await started({})).toEqual({ said: "Refused: invalid_input", by: undefined });
    } finally {
      await client.close();
    }
  });

  it("lists the sites in the Sites panel, each under its title with its pages, and names the site in the crumbs", async () => {
    const html = (await (await fetch(new URL("/sites/hello/", app.url))).text()).replaceAll("<!-- -->", "");
    // The bar's Sites, lit on a site's page, linking to the site's home (a typed path has no
    // trailing slash), and its panel docked beside it.
    expect(linkTag(html, "<span>Sites</span>")).toMatch(/^<a [^>]*data-active="true"[^>]*href="\/sites\/hello"/);
    expect(html).toContain(">Sites</h2>");
    expect(html).toContain(">Hello desk</h3>");
    // The site's pages, its home first and marked while open.
    expect(linkTag(html, ">Home</span>")).toMatch(/href="\/sites\/hello"[^>]*aria-current="page"/);
    expect(linkTag(html, ">/styled</span>")).toContain('href="/sites/hello/styled"');
    expect(html.indexOf(">Home</span>")).toBeLessThan(html.indexOf(">/styled</span>"));
    expect(html).toMatch(/data-slot="breadcrumb-page"[^>]*>Hello desk</);
    // An app page has Sites in its bar, and its own panel.
    const workflows = (await (await fetch(new URL("/workflows", app.url))).text()).replaceAll("<!-- -->", "");
    expect(linkTag(workflows, "<span>Sites</span>")).toContain('href="/sites/hello"');
    expect(workflows).not.toContain(">Hello desk</h3>");
  });

  it("gives a site's `sanoma/site` imports the app's one router and React", async () => {
    // Each copy's markers, counted in the browser's bundle: as many as a build with no sites has.
    const router = "__TSR_ROUTER__";
    const markers = [router, "react.transitional.element", "react.portal"];
    const count = (distDir: string) => {
      const dir = join(distDir, "client", "assets");
      const code = readdirSync(dir)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("\n");
      return Object.fromEntries(markers.map((marker) => [marker, code.split(marker).length - 1]));
    };
    const bare = company();
    rmSync(join(bare, "sites"), { recursive: true });
    const withoutSites = count((await buildApp(bare)).distDir);
    expect(withoutSites[router]).toBe(1);
    expect(count(result.distDir)).toEqual(withoutSites);
  });

  it("imports the runtime by URL from the server bundle, and keeps it out of the browser's", () => {
    const server = join(result.distDir, "server");
    // Every import that is not relative is Node's or a file URL: nothing from the company's install.
    const imported = readdirSync(server, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) => [
        ...readFileSync(join(server, file), "utf8").matchAll(/^(?:import|export)\b[^"'\n]*?["']([^"']+)["']/gm),
      ])
      .map(([, specifier]) => specifier!)
      .filter((specifier) => !specifier.startsWith("."));
    expect(imported).toContain("node:fs");
    expect(imported.filter((specifier) => !/^(node:|file:\/\/)|^module$/.test(specifier))).toEqual([]);
    expect(imported.some((specifier) => /^file:.*\/workflows\/dist\/index\.js$/.test(specifier))).toBe(true);
    const client = join(result.distDir, "client", "assets");
    // Tailwind finds a site's classes from the repo, the root.
    const css = readdirSync(client).filter((f) => f.endsWith(".css"));
    expect(css.some((f) => readFileSync(join(client, f), "utf8").includes("letter-spacing:.37em"))).toBe(true);
    for (const file of readdirSync(client).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(join(client, file), "utf8");
      expect(code, file).not.toMatch(/DBOSClient|systemDatabaseUrl|@cucumber|faker|pg-protocol|pg-pool|pg_notify/);
    }
  });

  it("links a site's own stylesheet, Tailwind's theme and utilities with the site's classes, and every stylesheet the server links is one the build wrote", async () => {
    const html = await (await fetch(new URL("/sites/hello/styled", app.url))).text();
    const hrefs = stylesheets(html);
    // The app's and the site's: the server's render and the client's build agree on each file's
    // hash, so the first paint is styled.
    expect(hrefs).toHaveLength(2);
    const css = hrefs.map((href) => {
      const file = join(result.distDir, "client", href);
      expect(existsSync(file), href).toBe(true);
      return readFileSync(file, "utf8");
    });
    const site = css.find((text) => !text.includes("--sidebar"));
    expect(site).toContain("letter-spacing:.37em");
  });

  it("renders content from content/: the list and a post's HTML, from a chunk of its own, and never a draft", async () => {
    const list = await fetch(new URL("/sites/hello/posts/", app.url));
    expect(list.status).toBe(200);
    const html = (await list.text()).replaceAll("<!-- -->", "");
    expect(linkTag(html, "Hello, content")).toContain('href="/sites/hello/posts/hello"');
    expect(html).toContain("The first post, from content/posts.");
    const post = (await (await fetch(new URL("/sites/hello/posts/hello", app.url))).text()).replaceAll("<!-- -->", "");
    expect(post).toContain("<h1>Hello, content</h1>");
    expect(post).toMatch(/<article class="prose"><p>A post from <strong>content\/<\/strong>, rendered at build\.<\/p>/);
    expect(post).toContain("<td>Free</td>");
    // A draft is in no page and no file the browser is sent.
    expect(html).not.toContain("Not yet");
    expect((await fetch(new URL("/sites/hello/posts/draft", app.url))).status).toBe(404);
    const client = join(result.distDir, "client");
    const files = readdirSync(client, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const holding = (text: string) =>
      files.filter((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8").includes(text));
    expect(holding("unpublished-draft-words")).toEqual([]);
    // The posts are one chunk, which only content's import loads.
    expect(holding("rendered at build").map((entry) => entry.name)).toEqual([expect.stringMatching(/content.*\.js$/)]);
  });

  /** `path` on the app, as `host` (on the app's port) asks for it. */
  const at = (path: string, host: string, init?: Parameters<typeof rawGet>[2]) =>
    rawGet(new URL(path, app.url).href, `${host}:${new URL(app.url).port}`, init);

  it("serves a public site at the root of <name>.localhost: its own document, with no app stylesheet, chrome or cookie", async () => {
    const home = await at("/", "hello.localhost");
    expect(home.status).toBe(200);
    const html = home.body.replaceAll("<!-- -->", "");
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en" data-site="hello">/);
    expect(html).toContain("Hello from the hello site");
    expect(html).not.toContain("sidebar-wrapper");
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/);
    expect(home.headers["set-cookie"]).toBeUndefined();
    // Its links are to its pages at the root, and its other pages answer there.
    expect(linkTag(html, "Greet someone")).toContain('href="/run"');
    expect((await at("/posts/hello", "hello.localhost")).body).toContain("<h1>Hello, content</h1>");
    expect(app.sites).toEqual({
      hello: `http://hello.localhost:${new URL(app.url).port}`,
      members: `http://members.localhost:${new URL(app.url).port}`,
    });
  });

  it("answers a public host's request for the app's pages, routes, a staff login's routes or a staff server function with a 404", async () => {
    for (const path of [
      "/workflows",
      "/sites/hello",
      "/setup/github/manifest",
      "/auth/github/start",
      "/auth/loopback",
    ]) {
      expect((await at(path, "hello.localhost")).status, path).toBe(404);
    }
    expect((await at("/", "hello.localhost", { method: "PUT" })).status).toBe(405);
    // The config, a read on the app's host; on the public host not there, nor is any change.
    const getConfig = `/_serverFn/${serverFnId(result.distDir, "getConfig")}`;
    expect((await at(getConfig, "127.0.0.1", { headers: SAME_ORIGIN })).status).toBe(200);
    // A read that is not there is the router's not-found, as for any read that finds nothing.
    const read = await at(getConfig, "hello.localhost", { headers: SAME_ORIGIN });
    expect(read.body).toContain('"isNotFound"');
    expect(read.body).not.toContain("hello");
    const startRun = `/_serverFn/${serverFnId(result.distDir, "startRunFn")}`;
    expect((await at(startRun, "hello.localhost", { method: "POST", headers: SAME_ORIGIN })).status).toBe(404);
  });

  it("runs a public page's loader as anonymous whatever the staff login's cookie or header says, and as the visitor its login verifies", async () => {
    const client = await SanomaClient.connect(config);
    try {
      /** What the `started` page on `host` answered, and who started the run it started. */
      const started = async (host: string, headers: Record<string, string> = {}) => {
        const html = (await at("/started", host, { headers })).body.replaceAll("<!-- -->", "");
        const said = html.match(/<p>((?:Started|Refused:) [^<]+)<\/p>/)?.[1];
        const runId = said?.match(/^Started (.+)$/)?.[1];
        return { said, by: runId && (await client.run(runId))?.startedBy };
      };
      const anonymous = { said: expect.stringMatching(/^Started /), by: { id: "anonymous" } };
      // The fixture's policy permits anonymous to start hello.
      expect(await started("hello.localhost", { cookie: `${ACTOR_COOKIE}=ada`, [ACTOR_HEADER]: "ada" })).toEqual(
        anonymous,
      );
      expect(await started("members.localhost")).toEqual(anonymous);
      // And no permit names the visitors.
      expect(await started("members.localhost", { cookie: "x-fixture-visitor=ada" })).toEqual({
        said: `Refused: workflow:hello was denied by policy: ${VISITOR_DENIED}`,
        by: undefined,
      });
    } finally {
      await client.close();
    }
  });

  it("says who is on a public page: the visitor its login verifies, with its sign-out, or nobody", async () => {
    const getActor = `/_serverFn/${serverFnId(result.distDir, "getActor")}`;
    const visitor = await at(getActor, "members.localhost", {
      headers: { ...SAME_ORIGIN, cookie: "x-fixture-visitor=ada" },
    });
    expect(visitor.status).toBe(200);
    expect(visitor.body).toContain('"visitor:fixture-login:ada"');
    expect(visitor.body).toContain('"visitors"');
    expect(visitor.body).toContain('"/auth/fixture-login/sign-out"');
    const nobody = await at(getActor, "hello.localhost", {
      headers: { ...SAME_ORIGIN, cookie: `${ACTOR_COOKIE}=ada` },
    });
    expect(nobody.status).toBe(200);
    expect(nobody.body).not.toContain("anonymous");
    expect(nobody.body).not.toContain("ada");
    // The login's own routes, and its sign-out, on its site's host alone.
    const signOut = await at("/auth/fixture-login/sign-out", "members.localhost", { method: "POST" });
    expect([signOut.status, signOut.headers["set-cookie"]]).toEqual([204, ["x-fixture-visitor=; Max-Age=0; Path=/"]]);
    expect((await at("/auth/fixture-login/sign-out", "hello.localhost", { method: "POST" })).status).toBe(404);
    expect(loginContexts[0]).toMatchObject({
      origins: ["http://members.localhost:*"],
      databaseUrl: config.databaseUrl,
    });
  });

  it("serves a public site at its domain too and links to it from the Sites panel, but no domain of a site that is not public", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const domains = { hello: "hello.example", members: "members.example", leads: "leads.example" };
    const second = await startApp(config, { port: 0, distDir: result.distDir, domains });
    try {
      const home = await rawGet(new URL("/", second.url).href, "hello.example");
      expect(home.body).toContain('data-site="hello"');
      expect((await rawGet(new URL("/", second.url).href, "leads.example")).status).toBe(403);
      expect(warn).toHaveBeenCalledWith(
        "sanoma app: the domain leads.example names sites/leads, which is not a public site: not served",
      );
      // The site's own address, beside its pages in the app's Sites panel.
      const panel = (await (await fetch(new URL("/sites/hello", second.url))).text()).replaceAll("<!-- -->", "");
      expect(panel).toContain('data-slot="sidebar-wrapper"');
      expect(linkTag(panel, ">hello.example</span>")).toMatch(/href="https:\/\/hello\.example\/"[^>]*target="_blank"/);
      expect(loginContexts.at(-1)?.origins).toEqual(["http://members.localhost:*", "https://members.example"]);
    } finally {
      warn.mockRestore();
      await second.close();
    }
  });

  it("serves a public site whose site.ts has a problem, or whose login fails to start, on no host", async () => {
    const broken = company({
      "sites/hello/site.ts":
        'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ public: true, login: "nope" });\n',
    });
    const failing = withSetup(defineConnector("fixture-login", {}), {
      login: () => {
        throw new Error("no secret");
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const third = await startApp(defineConfig({ ...config, root: broken, connectors: [failing] }), {
      port: 0,
      distDir: result.distDir,
      // Another site's host: one site per host.
      domains: { members: "hello.localhost" },
    });
    try {
      expect(third.sites).toEqual({});
      for (const host of ["hello.localhost", "members.localhost"]) {
        expect((await rawGet(new URL("/", third.url).href, host)).status, host).toBe(503);
      }
      expect(warn).toHaveBeenCalledWith(
        "sanoma app: sites/hello/site.ts has a problem: the site is served on no host until it is fixed",
      );
      expect(warn).toHaveBeenCalledWith(
        "sanoma app: hello.localhost is another public site's host: sites/members is not served there",
      );
      expect(error).toHaveBeenCalledWith(
        "sanoma app: sites/members's login (fixture-login) could not start, so the site is not served: no secret",
      );
      // The app itself answers.
      expect((await fetch(new URL("/workflows", third.url))).status).toBe(200);
    } finally {
      error.mockRestore();
      warn.mockRestore();
      await third.close();
    }
  });

  it("reuses a build of the same sites, and builds again when a site changes", async () => {
    expect(await buildApp(repo)).toEqual({ distDir: result.distDir, built: false });
    writeFileSync(join(repo, "sites", "hello", "routes", "about.tsx"), sitePage("/sites/hello/about", "", '"About"'));
    const changed = await buildApp(repo);
    expect(changed.built).toBe(true);
    expect(changed.distDir).not.toBe(result.distDir);
    // The first is still there, for an app that serves it.
    expect(existsSync(join(result.distDir, "server", "server.js"))).toBe(true);
    // Back to the first sites, the first build and its route tree, which the sites' tsc reads.
    const tree = join(repo, ".sanoma", "app", "routeTree.gen.ts");
    expect(readFileSync(tree, "utf8")).toContain("/sites/hello/about");
    rmSync(join(repo, "sites", "hello", "routes", "about.tsx"));
    expect(await buildApp(repo)).toEqual({ distDir: result.distDir, built: false });
    expect(readFileSync(tree, "utf8")).not.toContain("/sites/hello/about");
    // And when content changes.
    const post = join(repo, "content", "posts", "hello.md");
    const text = readFileSync(post, "utf8");
    writeFileSync(post, text.replace("rendered at build", "edited"));
    expect((await buildApp(repo)).built).toBe(true);
    writeFileSync(post, text);
    expect(await buildApp(repo)).toEqual({ distDir: result.distDir, built: false });
  });

  it("lists under a workflow's Used by the site's pages that call it, each linking to its page, and a component's file", async () => {
    const html = (await (await fetch(new URL("/workflows/hello", app.url))).text()).replaceAll("<!-- -->", "");
    expect(html).toMatch(/<h3[^>]*>Used by<\/h3>/);
    const usedBy = sectionAfter(html, "Used by");
    for (const [page, via] of [
      ["/sites/hello/run", "RunForm"],
      ["/sites/hello/started", "api"],
    ]) {
      expect(linkTag(usedBy, `${page}</code>`)).toContain(`href="${page}"`);
      expect(usedBy).toMatch(new RegExp(`Hello desk<code[^>]*>${page}</code>.*?through ${via}<`));
    }
    // A component's file, which is no one page, unlinked (first, as its file sorts first); the page
    // that reads leads, which calls no workflow, is not listed.
    expect(usedBy).toMatch(/Hello desk<code[^>]*>sites\/hello\/components\/greet\.tsx<\/code>.*?through api</);
    expect(usedBy.indexOf("greet.tsx")).toBeLessThan(usedBy.indexOf("<a "));
    expect(usedBy).not.toContain("/sites/hello/leads");
  });

  it("lists under a collection's Used by the site's page that reads it, linking to the page", async () => {
    const html = (await (await fetch(new URL("/data/leads", app.url))).text()).replaceAll("<!-- -->", "");
    expect(html).toContain(">Used by</h2>");
    const usedBy = sectionAfter(html, "Used by");
    expect(usedBy).toMatch(/Hello desk<code[^>]*>\/sites\/hello\/leads<\/code>.*?through api</);
    expect(linkTag(usedBy, "/sites/hello/leads</code>")).toContain('href="/sites/hello/leads"');
    // No workflow uses leads, and the pages that call only hello are not listed.
    expect(usedBy).not.toContain("/workflows/");
    expect(usedBy).not.toContain("/sites/hello/run");
  });

  it("type-checks a site's links against the app's pages and the sites', refuses a path that is neither, and types a refusal", async () => {
    // The tsc a company runs: sanoma's.
    const sanoma = createRequire(join(realpathSync(join(repo, "node_modules", "sanoma")), "package.json"));
    const tsc = join(dirname(sanoma.resolve("typescript/package.json")), "bin", "tsc");
    const check = () =>
      spawnSync(process.execPath, [tsc, "-p", "sites/tsconfig.json", "--pretty", "false"], {
        cwd: repo,
        encoding: "utf8",
      });
    // The fixture's links: to /workflows, an app page, and back to the site's home.
    expect(check()).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(
      join(repo, "sites", "hello", "routes", "styled.tsx"),
      sitePage("/sites/hello/styled", 'import { Link } from "sanoma/site";', '<Link to="/sites/nope">Nope</Link>'),
    );
    const refused = check();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toMatch(/^sites\/hello\/routes\/styled\.tsx\(\d+,\d+\): error TS\d+: [^\n]*"\/sites\/nope"/);
    // `api` is untyped until .sanoma/api.ts types it (the fixture's started.tsx, above), as the
    // generated file does: through Register, with the types sanoma/site re-exports.
    expect((await writeApi(repo, describeConfig(config))).wrote).toBe(true);
    // A start, and its refusal read without a cast; then input and a code the runtime does not take.
    writeFileSync(join(repo, "sites", "hello", "routes", "styled.tsx"), starting('"Ada"', "approval_pending"));
    expect(check()).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(join(repo, "sites", "hello", "routes", "styled.tsx"), starting("1", "approval_pendng"));
    const { stdout } = check();
    expect(stdout).toMatch(/^sites\/hello\/routes\/styled\.tsx\(\d+,\d+\): error TS2322: [^\n]*'number'/m);
    expect(stdout).toMatch(/^sites\/hello\/routes\/styled\.tsx\(\d+,\d+\): error TS2367: [^\n]*"approval_pendng"/m);
  });
});

describe("sanoma/ui", () => {
  it("exports the kit's list and nothing else, so each addition is deliberate", async () => {
    // By a path TypeScript does not follow: the kit is JSX and DOM, checked by typecheck:ui.
    const ui = (await import(new URL("../src/ui.ts", import.meta.url).href)) as Record<string, unknown>;
    expect(Object.keys(ui).toSorted()).toMatchInlineSnapshot(`
      [
        "Alert",
        "AlertAction",
        "AlertDescription",
        "AlertTitle",
        "Avatar",
        "AvatarBadge",
        "AvatarFallback",
        "AvatarGroup",
        "AvatarGroupCount",
        "AvatarImage",
        "Badge",
        "Breadcrumb",
        "BreadcrumbEllipsis",
        "BreadcrumbItem",
        "BreadcrumbLink",
        "BreadcrumbList",
        "BreadcrumbPage",
        "BreadcrumbSeparator",
        "Button",
        "ButtonGroup",
        "ButtonGroupSeparator",
        "ButtonGroupText",
        "ButtonLink",
        "Card",
        "CardAction",
        "CardContent",
        "CardDescription",
        "CardFooter",
        "CardHeader",
        "CardTitle",
        "Checkbox",
        "Collapsible",
        "CollapsibleContent",
        "CollapsibleTrigger",
        "Dialog",
        "DialogClose",
        "DialogContent",
        "DialogDescription",
        "DialogFooter",
        "DialogHeader",
        "DialogTitle",
        "DialogTrigger",
        "DropdownMenu",
        "DropdownMenuCheckboxItem",
        "DropdownMenuContent",
        "DropdownMenuGroup",
        "DropdownMenuItem",
        "DropdownMenuLabel",
        "DropdownMenuRadioGroup",
        "DropdownMenuRadioItem",
        "DropdownMenuSeparator",
        "DropdownMenuShortcut",
        "DropdownMenuSub",
        "DropdownMenuSubContent",
        "DropdownMenuSubTrigger",
        "DropdownMenuTrigger",
        "Empty",
        "EmptyContent",
        "EmptyDescription",
        "EmptyHeader",
        "EmptyMedia",
        "EmptyTitle",
        "Fact",
        "Facts",
        "Field",
        "FieldContent",
        "FieldDescription",
        "FieldError",
        "FieldGroup",
        "FieldLabel",
        "FieldLegend",
        "FieldSeparator",
        "FieldSet",
        "FieldTitle",
        "Input",
        "Item",
        "ItemActions",
        "ItemContent",
        "ItemDescription",
        "ItemFooter",
        "ItemGroup",
        "ItemHeader",
        "ItemMedia",
        "ItemSeparator",
        "ItemTitle",
        "Label",
        "NativeSelect",
        "NativeSelectOptGroup",
        "NativeSelectOption",
        "Nothing",
        "Notice",
        "PageHeader",
        "Popover",
        "PopoverContent",
        "PopoverDescription",
        "PopoverHeader",
        "PopoverTitle",
        "PopoverTrigger",
        "Region",
        "RunForm",
        "Separator",
        "Sheet",
        "SheetClose",
        "SheetContent",
        "SheetDescription",
        "SheetFooter",
        "SheetHeader",
        "SheetTitle",
        "SheetTrigger",
        "Skeleton",
        "Slider",
        "Spinner",
        "StatusDot",
        "Table",
        "TableBody",
        "TableCaption",
        "TableCell",
        "TableFooter",
        "TableHead",
        "TableHeader",
        "TableRow",
        "Tabs",
        "TabsContent",
        "TabsList",
        "TabsTrigger",
        "Textarea",
        "Tip",
        "ToneBadge",
        "Tooltip",
        "TooltipContent",
        "TooltipTrigger",
        "effectBadge",
        "toast",
        "toneBadge",
        "useActor",
        "useDensity",
      ]
    `);
  });
});

describe("the sites' generated files", () => {
  it("are the fixture's committed ones, and the tsconfig the sites extend is written when it changes", () => {
    const repo = company();
    rmSync(join(repo, "sites", "__virtual.ts"));
    rmSync(join(repo, "sites", "tsconfig.json"));
    writeSiteFiles(repo);
    for (const file of ["__virtual.ts", "tsconfig.json"]) {
      expect(readFileSync(join(repo, "sites", file), "utf8"), file).toBe(
        readFileSync(join(fixtureDir, "sites", file), "utf8"),
      );
    }
    const tsconfig = JSON.parse(readFileSync(join(repo, ".sanoma", "app", "tsconfig.json"), "utf8"));
    expect(tsconfig.extends).toBe(join(appDir, "tsconfig.site.json"));
    expect(tsconfig.include).toContain("../api.ts");
    expect(tsconfig.include).toContain("../content.ts");
    // The content's types, drafts among them.
    expect(readFileSync(join(repo, ".sanoma", "content.ts"), "utf8")).toContain(
      "posts: ContentKind<{ title: string; description: string; draft?: boolean; publishedAt?: string }>;",
    );
    // Written again unchanged, nothing is rewritten: a dev server would reload every page.
    const written = [
      join(repo, "sites", "__virtual.ts"),
      join(repo, ".sanoma", "app", "tsconfig.json"),
      join(repo, ".sanoma", "content.ts"),
    ];
    const mtimes = written.map((file) => lstatSync(file).mtimeMs);
    writeSiteFiles(repo);
    expect(written.map((file) => lstatSync(file).mtimeMs)).toEqual(mtimes);
  });
});

describe("a build that fails, or leaves a site out", () => {
  it.each([
    ["the runtime", '"@sanoma-ai/workflows"'],
    ["the runtime through sanoma", '"sanoma"'],
    ["the app's Node entry", '"@sanoma-ai/app"'],
  ])("refuses a site that imports %s", async (_, from) => {
    const repo = company({
      "sites/hello/routes/index.tsx": sitePage("/sites/hello/", `import * as runtime from ${from};`, "String(runtime)"),
    });
    await expect(buildApp(repo)).rejects.toThrow(/Import denied in client environment/);
  });

  it("builds a site whose site.ts has no default export, named by its folder, and whose stylesheet imports all of Tailwind", async () => {
    const repo = company({
      "sites/hello/site.ts": "export const title = 'Not this';\n",
      // From the app's install, preflight and all.
      "sites/hello/style.css": '@import "tailwindcss";\n',
      "sites/hello/routes/styled.tsx": styledPage,
    });
    expect((await buildApp(repo)).built).toBe(true);
  });

  it("refuses a site that imports a .server.ts file", async () => {
    const repo = company({
      "sites/hello/secret.server.ts": 'export const secret = () => "s";\n',
      "sites/hello/routes/index.tsx": sitePage(
        "/sites/hello/",
        'import { secret } from "../secret.server.ts";',
        "secret()",
      ),
    });
    await expect(buildApp(repo)).rejects.toThrow(/Import denied in client environment/);
    // Nothing left half built.
    const builds = join(repo, ".sanoma", "app", "build");
    expect(existsSync(builds) ? readdirSync(builds) : []).toEqual([]);
  });

  it("names the path two pages claim, and their files", async () => {
    const repo = company({
      "sites/hello/routes/(again)/index.tsx": sitePage("/sites/hello/(again)/", "", '"Again"'),
    });
    await expect(buildApp(repo)).rejects.toThrow(
      "More than one page claims /sites/hello/: sites/hello/routes/index.tsx, sites/hello/routes/(again)/index.tsx",
    );
  });

  it("reports a folder whose name is not a URL segment, and does not mount it", async () => {
    const repo = company({
      "sites/Not_A_Segment/routes/index.tsx": sitePage("/sites/Not_A_Segment/", "", '"Refused"'),
    });
    expect(sitesOf(repo)).toEqual({ sites: ["hello", "members"], refused: ["Not_A_Segment"] });
    const lines: string[] = [];
    const { distDir } = await buildApp(repo, { log: (line) => lines.push(line) });
    expect(lines).toContain(
      "sites/Not_A_Segment is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)",
    );
    const tree = readFileSync(join(dirname(dirname(distDir)), "routeTree.gen.ts"), "utf8");
    expect(tree).toContain("id: '/sites/hello/'");
    expect(tree).not.toContain("Not_A_Segment");
  });
});
