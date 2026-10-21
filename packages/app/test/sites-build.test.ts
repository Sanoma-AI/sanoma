import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, sitesOf, writeSiteFiles } from "@sanoma-ai/app/build";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { defineConfig, startWorker, type Worker } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, startApp } from "../src/index.ts";
import fixture from "./fixtures/company-sites/sanoma.config.ts";

// Needs Postgres (`pnpm db:up`) and the built workflows package: the server bundle imports the
// runtime from its dist/.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/company-sites/", import.meta.url));
const config = defineConfig({ ...fixture, databaseUrl: testDatabaseUrl("sites_build") });

const repos: string[] = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/** A copy of the fixture company, outside this checkout, with `files` written over it. */
function company(files: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-sites-"));
  repos.push(repo);
  cpSync(fixtureDir, repo, { recursive: true });
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

/** A site page at /sites/hello/ that imports `line`, and shows `shown`. */
const helloImporting = (line: string, shown: string) => `import { createFileRoute } from "@tanstack/react-router";
${line}

export const Route = createFileRoute("/sites/hello/")({ component: () => <p>{${shown}}</p> });
`;

describe("a company's app with its sites", () => {
  const repo = company();
  const untouched = { src: join(appDir, "src"), modules: join(appDir, "node_modules") };
  const before = { src: [] as string[], modules: [] as string[] };
  let result: { distDir: string; built: boolean };
  let worker: Worker;
  let app: App;

  beforeAll(async () => {
    before.src = entries(untouched.src);
    before.modules = entries(untouched.modules);
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
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
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
    for (const file of readdirSync(client).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(join(client, file), "utf8");
      expect(code, file).not.toMatch(/DBOSClient|systemDatabaseUrl|@cucumber|faker|pg-protocol|pg-pool|pg_notify/);
    }
  });

  it("reuses a build of the same sites, and builds again when a site changes", async () => {
    expect(await buildApp(repo)).toEqual({ distDir: result.distDir, built: false });
    writeFileSync(
      join(repo, "sites", "hello", "routes", "about.tsx"),
      helloImporting("", '"About"').replace("/sites/hello/", "/sites/hello/about"),
    );
    const changed = await buildApp(repo);
    expect(changed.built).toBe(true);
    expect(changed.distDir).not.toBe(result.distDir);
    // The first is still there, for an app that serves it.
    expect(existsSync(join(result.distDir, "server", "server.js"))).toBe(true);
  });
});

describe("the sites' generated files", () => {
  it("are the fixture's committed ones, and the tsconfig the sites extend is written every time", () => {
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
  });
});

describe("a build that fails, or leaves a site out", () => {
  it("refuses a site that imports the runtime", async () => {
    const repo = company({
      "sites/hello/routes/index.tsx": helloImporting(
        'import { startWorker } from "@sanoma-ai/workflows";',
        "String(startWorker)",
      ),
    });
    await expect(buildApp(repo)).rejects.toThrow(/Import denied in client environment/);
  });

  it("refuses a site that imports a .server.ts file", async () => {
    const repo = company({
      "sites/hello/secret.server.ts": 'export const secret = () => "s";\n',
      "sites/hello/routes/index.tsx": helloImporting('import { secret } from "../secret.server.ts";', "secret()"),
    });
    await expect(buildApp(repo)).rejects.toThrow(/Import denied in client environment/);
    // Nothing left half built.
    const builds = join(repo, ".sanoma", "app", "build");
    expect(existsSync(builds) ? readdirSync(builds) : []).toEqual([]);
  });

  it("names the path two pages claim, and their files", async () => {
    const repo = company({
      "sites/hello/routes/(again)/index.tsx": helloImporting("", '"Again"').replace(
        "/sites/hello/",
        "/sites/hello/(again)/",
      ),
    });
    await expect(buildApp(repo)).rejects.toThrow(
      "More than one page claims /sites/hello/: sites/hello/routes/index.tsx, sites/hello/routes/(again)/index.tsx",
    );
  });

  it("reports a folder whose name is not a URL segment, and does not mount it", async () => {
    const repo = company({
      "sites/Not_A_Segment/routes/index.tsx": helloImporting("", '"Refused"').replace(
        "/sites/hello/",
        "/sites/Not_A_Segment/",
      ),
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
