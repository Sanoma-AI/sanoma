import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { type Browser, executablePath, launch } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, runCli, serving } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) and the packages' builds, as cli.test.ts. The fixture is a company
// with one site, sites/hello, which `sanoma serve` builds into the app from the app's shipped
// source and `sanoma` serves from Vite's dev server. The one test in a browser needs Google
// Chrome, or `CHROME_PATH` naming a Chrome or Chromium binary, and skips without either.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-sites"), SANOMA_APP_PORT: "0" };
const fixture = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

let dir = "";
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The bin with `args` (`sanoma serve`) in `cwd` until it listens (`serving`). */
const started = (cwd: string, args = ["serve"]) => serving(cwd, args, env);

/** The bin with `args` in the fixture copy until it listens, `probe` on its address, then SIGINT: what it printed. */
async function serveOnce(probe: (url: string) => Promise<void>, args?: string[]): Promise<string> {
  const { url, stop } = await started(dir, args);
  let stderr = "";
  try {
    await probe(url);
  } finally {
    stderr = await stop();
  }
  return stderr;
}

/**
 * A fixture copy with `sanoma` alone installed, as a company has it: no package of this checkout
 * linked in (`copyFixture` links the ghost connector), so `sanoma` runs as it does there, not in
 * dev mode.
 */
function installedCopy(): string {
  const copy = copyFixture(fixture);
  rmSync(join(copy, "node_modules/@sanoma-ai"), { recursive: true, force: true });
  return copy;
}

/**
 * A GET to `url` with `host` as its Host, which fetch does not let a caller set, and so with no
 * need for `*.localhost` to resolve (it does not on every Linux).
 */
function rawGet(url: string, host: string): Promise<{ status: number; body: string }> {
  const { hostname, port, pathname } = new URL(url);
  return new Promise((done, fail) => {
    httpRequest({ host: hostname, port, path: pathname, headers: { host, accept: "text/html" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    })
      .on("error", fail)
      .end();
  });
}

describe("sanoma serve with sites", () => {
  it("builds the app with the sites before it starts, serves a site in the app's shell, and reuses the build", async () => {
    dir = copyFixture(fixture);
    const first = await serveOnce(async (url) => {
      const site = await fetch(`${url}/sites/hello`);
      expect(site.status).toBe(200);
      const html = (await site.text()).replaceAll("<!-- -->", "");
      expect(html).toContain("The hello site");
      expect(html).toContain("Hello from the hello site");
      expect(html).toContain('data-slot="sidebar-wrapper"');
      expect((await fetch(`${url}/workflows`)).status).toBe(200);
    });
    expect(first).toContain("building the app with 1 site (hello)");
    expect(first).not.toContain("app build up to date");
    // The generated files C10 names: the committed ones unchanged, the ignored ones under .sanoma/app.
    for (const file of ["__virtual.ts", "tsconfig.json"]) {
      expect(readFileSync(join(dir, "sites", file), "utf8"), file).toBe(
        readFileSync(join(fixture, "sites", file), "utf8"),
      );
    }
    expect(existsSync(join(dir, ".sanoma/app/tsconfig.json"))).toBe(true);
    expect(existsSync(join(dir, ".sanoma/app/routeTree.gen.ts"))).toBe(true);

    const second = await serveOnce(async (url) => {
      expect((await fetch(`${url}/sites/hello`)).status).toBe(200);
    });
    expect(second).toContain("app build up to date");
  }, 180_000);
});

describe("sanoma check with sites", () => {
  it("passes the fixture: the sites built and type-checked with the app", async () => {
    dir = copyFixture(fixture);
    const ok = await runCli(dir, ["check"], env);
    expect(ok.code, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(ok.stderr).toContain("build hello");
    expect(ok.stderr).toContain("tsc sites/tsconfig.json");
    expect(ok.stderr.trimEnd().split("\n").at(-1)).toBe("ok");
  }, 180_000);

  it("reports a link to a page that does not exist, an import the browser may not make and a call to a workflow that does not exist at their lines, and a folder whose name is not a URL segment", async () => {
    dir = copyFixture(fixture);
    const index = join(dir, "sites/hello/routes/index.tsx");
    writeFileSync(index, readFileSync(index, "utf8").replace('to="/workflows"', 'to="/sites/hello/nope"'));
    writeFileSync(
      join(dir, "sites/hello/routes/runtime.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";
import * as runtime from "@sanoma-ai/workflows";

export const Route = createFileRoute("/sites/hello/runtime")({ component: () => <p>{String(runtime)}</p> });
`,
    );
    writeFileSync(
      join(dir, "sites/hello/routes/gone.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "@sanoma-ai/app/ui";

export const Route = createFileRoute("/sites/hello/gone")({ component: () => <RunForm workflow="gone" /> });
`,
    );
    mkdirSync(join(dir, "sites/Bad_Name/routes"), { recursive: true });
    writeFileSync(join(dir, "content/posts/bad.md"), "---\n\ttitle: Tabbed\n---\n");
    const found = await runCli(dir, ["check"], env);
    expect(found.code, found.stderr).toBe(1);
    const problems = found.stdout.trimEnd().split("\n");
    expect(problems).toContain("content/posts/bad.md:2:1: front matter: Tabs are not allowed as indentation");
    expect(problems).toContain('sites/hello/routes/gone.tsx:4:78: calls workflow "gone", which does not exist');
    expect(problems).toContainEqual(
      expect.stringMatching(/^sites\/hello\/routes\/index\.tsx:9:\d+: error TS\d+: .*"\/sites\/hello\/nope"/),
    );
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^sites\/hello\/routes\/runtime\.tsx:4:\d+: Import denied in client environment: "@sanoma-ai\/workflows"$/,
      ),
    );
    expect(problems).toContain(
      "sites/Bad_Name: a site's folder name is a URL segment (lowercase letters, digits and dashes)",
    );
    // One line each: none of the build error's trace or stack.
    expect(found.stdout).not.toContain("Trace:");
    expect(found.stdout).not.toMatch(/^\s+at /m);
  }, 180_000);

  it("writes nothing for a sites/ with no site, and reports a folder refused for its name", async () => {
    dir = copyFixture(fixture);
    rmSync(join(dir, "sites"), { recursive: true });
    mkdirSync(join(dir, "sites/Bad_Name/routes"), { recursive: true });
    const found = await runCli(dir, ["check"], env);
    expect(found.code, found.stderr).toBe(1);
    expect(found.stdout.trimEnd().split("\n")).toEqual([
      "sites/Bad_Name: a site's folder name is a URL segment (lowercase letters, digits and dashes)",
    ]);
    expect(found.stderr).not.toMatch(/^build /m);
    expect(existsSync(join(dir, "sites/__virtual.ts"))).toBe(false);
    expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "schema.cedarschema"]);
  }, 180_000);

  it("reports two pages claiming one path", async () => {
    dir = copyFixture(fixture);
    mkdirSync(join(dir, "sites/hello/routes/(again)"));
    writeFileSync(
      join(dir, "sites/hello/routes/(again)/index.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/hello/(again)/")({ component: () => <p>Again</p> });
`,
    );
    const found = await runCli(dir, ["check"], env);
    expect(found.code, found.stderr).toBe(1);
    expect(found.stdout).toContain(
      "More than one page claims /sites/hello/: sites/hello/routes/index.tsx, sites/hello/routes/(again)/index.tsx",
    );
  }, 180_000);
});

describe("sanoma with sites: the dev server", () => {
  let repo = "";
  let url = "";
  let running: Awaited<ReturnType<typeof started>> | undefined;
  // Closed after the server stops, so stopping is checked with a tab open on its hot updates.
  let browser: Browser | undefined;
  beforeAll(async () => {
    repo = installedCopy();
    running = await started(repo, []);
    url = running.url;
  }, 120_000);
  afterAll(async () => {
    try {
      await running?.stop();
    } finally {
      await browser?.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  /** The page that reads content/posts/hello.md, as the server renders it. */
  const page = async () => (await (await fetch(`${url}/sites/hello/post`)).text()).replaceAll("<!-- -->", "");

  it("serves a site in the app's shell, the app's pages and /healthz, refuses another Host, and builds nothing", async () => {
    expect(running!.output().stderr).toContain("serving the app with 1 site (hello) from Vite's dev server");
    expect(running!.output().stdout).toContain(`hello: http://hello.localhost:${new URL(url).port}\n`);
    const site = await fetch(`${url}/sites/hello`);
    expect(site.status).toBe(200);
    const html = (await site.text()).replaceAll("<!-- -->", "");
    expect(html).toContain("The hello site");
    expect(html).toContain("Hello from the hello site");
    expect(html).toContain('data-slot="sidebar-wrapper"');
    expect((await fetch(`${url}/workflows`)).status).toBe(200);
    const health = await fetch(`${url}/healthz`);
    expect([health.status, await health.text()]).toEqual([200, "ok\n"]);
    expect((await rawGet(`${url}/sites/hello`, "attacker.example:80")).status).toBe(403);
    // The public site at the root of its own host, with hot updates.
    const own = await rawGet(`${url}/`, `hello.localhost:${new URL(url).port}`);
    expect(own.status).toBe(200);
    expect(own.body).toContain('data-site="hello"');
    expect(own.body.replaceAll("<!-- -->", "")).toContain("Hello from the hello site");
    expect(own.body).not.toContain("sidebar-wrapper");
    expect(existsSync(join(repo, ".sanoma/app/build"))).toBe(false);
  }, 60_000);

  it("writes .sanoma/api.ts at start, and again when a workflow changes", async () => {
    const api = join(repo, ".sanoma/api.ts");
    expect(readFileSync(api, "utf8")).toContain("hello: WorkflowFn<{\n    who: string;\n  }, unknown>;");
    const workflow = join(repo, "workflows/hello.ts");
    writeFileSync(
      workflow,
      readFileSync(workflow, "utf8").replace("{ who: z.string() }", "{ who: z.string(), times: z.number() }"),
    );
    // The file, and the child's line, which crosses a pipe after it.
    await waitFor(
      () => ({ text: readFileSync(api, "utf8"), stderr: running!.output().stderr }),
      ({ text, stderr }) => text.includes("times: number;") && stderr.includes("wrote .sanoma/api.ts"),
      20_000,
    );
  }, 60_000);

  it("shows an edit to content/ on the next render, and types it again in .sanoma/content.ts", async () => {
    expect(await page()).toContain("Read from <strong>content/posts/hello.md</strong>.");
    const types = join(repo, ".sanoma/content.ts");
    expect(readFileSync(types, "utf8")).toContain("posts: ContentKind<{ title: string }>;");
    const post = join(repo, "content/posts/hello.md");
    writeFileSync(
      post,
      readFileSync(post, "utf8")
        .replace("title: The first post", "title: The first post\nsummary: Edited")
        .replace("Read from", "Edited in"),
    );
    await waitFor(page, (html) => html.includes("Edited in <strong>"), 20_000);
    expect(readFileSync(types, "utf8")).toContain("posts: ContentKind<{ title: string; summary: string }>;");
  }, 60_000);

  it("serves a new site folder without a restart", async () => {
    mkdirSync(join(repo, "sites/second/routes"), { recursive: true });
    writeFileSync(
      join(repo, "sites/second/routes/index.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/second/")({ component: () => <p>The second site</p> });
`,
    );
    const second = await waitFor(
      () => fetch(`${url}/sites/second`),
      (res) => res.status === 200,
      20_000,
    );
    expect(await second.text()).toContain("The second site");
  }, 60_000);

  it("hydrates a site with one React, updates it in place on an edit, and navigates to the app in the same document", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    browser = await launch({ executablePath: chrome, headless: true });
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1440, height: 900 });
    const errors: string[] = [];
    tab.on("console", (message) => void (message.type() === "error" && errors.push(message.text())));
    tab.on("pageerror", (err) => void errors.push(String(err)));
    // Strings, run in the page: this file is typed for Node, without the DOM's globals.
    // The name the app asks for once, and a stand-in for React's devtools, which every React
    // renderer that loads registers with.
    await tab.evaluateOnNewDocument(`
      localStorage.setItem("sanoma.actor", "tester");
      const renderers = new Map();
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers, supportsFiber: true, checkDCE() {}, onCommitFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
        inject(renderer) { renderers.set(renderers.size + 1, renderer); return renderers.size; },
      };
    `);
    await tab.goto(`${url}/sites/hello`, { waitUntil: "networkidle0" });
    await tab.evaluate("window.marker = 'kept'");

    const file = join(repo, "sites/hello/routes/index.tsx");
    writeFileSync(file, readFileSync(file, "utf8").replace("Hello from the hello site", "Hello, edited"));
    await tab.waitForFunction(`document.body.innerText.includes("Hello, edited")`);
    expect(await tab.evaluate("window.marker")).toBe("kept");

    await tab.click('section a[href="/workflows"]');
    await tab.waitForFunction(`location.pathname === "/workflows"`);
    expect(await tab.evaluate("window.marker")).toBe("kept");
    expect(await tab.evaluate("window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size")).toBe(1);
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("sanoma with a public site: its own host in a browser", () => {
  it("links to its pages at the root, hydrates with no error, and navigates in the same document", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    dir = installedCopy();
    const { url, stop } = await started(dir, []);
    const browser = await launch({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      const errors: string[] = [];
      tab.on("console", (message) => void (message.type() === "error" && errors.push(message.text())));
      tab.on("pageerror", (err) => void errors.push(String(err)));
      tab.on("response", (res) => void (res.status() >= 400 && errors.push(`${res.status()} ${res.url()}`)));
      // Chrome resolves `*.localhost` to this machine itself.
      await tab.goto(`http://hello.localhost:${new URL(url).port}/`, { waitUntil: "networkidle0" });
      // Strings, run in the page: this file is typed for Node, without the DOM's globals.
      expect(await tab.evaluate(`document.documentElement.dataset.site`)).toBe("hello");
      expect(await tab.evaluate(`document.querySelector("a[href='/post']")?.textContent`)).toBe("The post");
      expect(await tab.evaluate(`document.querySelector("a[href^='/sites/']")`)).toBeNull();
      await tab.evaluate("window.marker = 'kept'");
      await tab.click("a[href='/post']");
      await tab.waitForFunction(`location.pathname === "/post" && document.body.innerText.includes("The first post")`);
      expect(await tab.evaluate("window.marker")).toBe("kept");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await stop();
    }
  }, 120_000);
});

describe("sanoma without sites", () => {
  it("serves the app's own build, as before: no dev server, nothing written but the generated files", async () => {
    dir = installedCopy();
    rmSync(join(dir, "sites"), { recursive: true });
    const stderr = await serveOnce(async (url) => {
      expect((await fetch(`${url}/workflows`)).status).toBe(200);
    }, []);
    expect(stderr).not.toContain("dev server");
    expect(readdirSync(join(dir, ".sanoma"))).toEqual(["api.ts", "schema.cedarschema"]);
  }, 120_000);
});
