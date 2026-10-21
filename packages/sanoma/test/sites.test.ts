import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFixture, ensureBuilt, runCli, startCli } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`) and the packages' builds, as cli.test.ts. The fixture is a company
// with one site, sites/hello, which `sanoma` builds into the app from the app's shipped source.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-sites"), SANOMA_APP_PORT: "0" };
const fixture = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

let dir = "";
beforeAll(ensureBuilt, 600_000);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `sanoma serve` in the fixture copy until it listens, `probe` on its address, then SIGINT: what it printed. */
async function serveOnce(probe: (url: string) => Promise<void>): Promise<string> {
  const { child, finished, output } = startCli(dir, ["serve"], env);
  try {
    const stdout = await waitFor(
      () => output().stdout,
      (out) => / at http:\/\/127\.0\.0\.1:\d+; ctrl-c to stop/.test(out),
      60_000,
    );
    await probe(stdout.match(/at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/)![1]!);
  } finally {
    child.kill("SIGINT");
  }
  const done = await finished;
  expect(done.code, done.stderr).toBe(0);
  return done.stderr;
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

  it("reports a link to a page that does not exist and an import the browser may not make at their lines, and a folder whose name is not a URL segment", async () => {
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
    mkdirSync(join(dir, "sites/Bad_Name/routes"), { recursive: true });
    const found = await runCli(dir, ["check"], env);
    expect(found.code, found.stderr).toBe(1);
    const problems = found.stdout.trimEnd().split("\n");
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
    expect(existsSync(join(dir, ".sanoma"))).toBe(false);
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
