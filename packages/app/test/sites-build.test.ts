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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, sitesOf, writeSiteFiles } from "@sanoma-ai/app/build";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, SanomaClient, startWorker, type Worker } from "@sanoma-ai/workflows";
<<<<<<< HEAD
import { executablePath, launch } from "puppeteer-core";
=======
>>>>>>> 3923f63 (A4: callFn and the api client from sanoma/site, the loopback actor cookie for SSR)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTOR_COOKIE, ACTOR_HEADER } from "../src/api.ts";
import { type App, startApp } from "../src/index.ts";
import fixture from "./fixtures/company-sites/sanoma.config.ts";

// Needs Postgres (`pnpm db:up`) and the built workflows package (the server bundle imports the
// runtime from its dist/). The one test in a browser needs Google Chrome, or `CHROME_PATH` naming
// a Chrome or Chromium binary, and skips without either.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const config = defineConfig({ ...fixture, databaseUrl: testDatabaseUrl("sites_build") });

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

/** The opening tag of the link around the first `text`. */
function linkTag(html: string, text: string) {
  const start = html.lastIndexOf("<a ", html.indexOf(text));
  return start < 0 ? undefined : html.slice(start, html.indexOf(">", start) + 1);
}

/**
 * A class only a site uses, put together here so that Tailwind, scanning this package for the
 * package's own build, does not find it in this file.
 */
const siteClass = ["tracking", "[0.37em]"].join("-");

describe("a company's app with its sites", () => {
  const repo = company({
    "sites/hello/routes/styled.tsx": sitePage("/sites/hello/styled", "", `<span className="${siteClass}" />`),
    "sites/hello/routes/missing.tsx": sitePage(
      "/sites/hello/missing",
      'import { RunForm } from "@sanoma-ai/app/ui";',
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

<<<<<<< HEAD
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
=======
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
>>>>>>> 3923f63 (A4: callFn and the api client from sanoma/site, the loopback actor cookie for SSR)
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
  });

  it("type-checks a site's links against the app's pages and the sites', and refuses a path that is neither", () => {
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
    // `api` is untyped until .sanoma/api.ts types it (the fixture's started.tsx, above), as A5's
    // generated file does: through Register, with the types sanoma/site re-exports.
    writeFileSync(
      join(repo, ".sanoma", "api.ts"),
      `import type { WorkflowFn } from "sanoma/site";
declare module "sanoma/site" {
  interface Register {
    api: { hello: WorkflowFn<{ who: string }, { greeting: string }> };
  }
}
`,
    );
    const call = (who: string) =>
      sitePage("/sites/hello/styled", 'import { api } from "sanoma/site";', `void api.hello.start({ who: ${who} })`);
    writeFileSync(join(repo, "sites", "hello", "routes", "styled.tsx"), call('"Ada"'));
    expect(check()).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(join(repo, "sites", "hello", "routes", "styled.tsx"), call("1"));
    expect(check().stdout).toMatch(/^sites\/hello\/routes\/styled\.tsx\(\d+,\d+\): error TS2322: [^\n]*'number'/);
  });
});

describe("@sanoma-ai/app/ui", () => {
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
    // Written again unchanged, nothing is rewritten: a dev server would reload every page.
    const written = [join(repo, "sites", "__virtual.ts"), join(repo, ".sanoma", "app", "tsconfig.json")];
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

  it("builds a site whose site.ts has no default export, named by its folder", async () => {
    const repo = company({ "sites/hello/site.ts": "export const title = 'Not this';\n" });
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
    expect(sitesOf(repo)).toEqual({ sites: ["hello"], refused: ["Not_A_Segment"] });
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
