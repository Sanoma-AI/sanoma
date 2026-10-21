import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, repo as checkout, serving } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`), the packages' builds, and pnpm with the registry or a warm store
// (`--prefer-offline`): with no lockfile, the company's third-party dependencies resolve as a
// customer's do. This checkout's packages install as tarballs, under node_modules as from npm,
// where a linked checkout would hide issue #220; the installed bin runs the dev server.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-packed"), SANOMA_APP_PORT: "0" };
const fixture = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

/** `sanoma`'s dependencies from this checkout, by their directories: each packed, as `sanoma` is, into `vendor/<dir>.tgz`. */
const OVERRIDES = { "@sanoma-ai/app": "app", "@sanoma-ai/workflows": "workflows", "@sanoma-ai/bridge": "bridge" };

const { optionalDependencies: bridgeBinaries } = JSON.parse(
  readFileSync(join(checkout, "packages/bridge/package.json"), "utf8"),
) as { optionalDependencies: Record<string, string> };

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "packed-company",
    private: true,
    type: "module",
    dependencies: { sanoma: "file:vendor/sanoma.tgz" },
  }),
  // sanoma's dependencies on the others are by version: these tarballs instead of npm's. The
  // bridge's binaries stay out (the dev server does not start it).
  "pnpm-workspace.yaml": JSON.stringify({
    overrides: {
      ...Object.fromEntries(Object.entries(OVERRIDES).map(([name, dir]) => [name, `file:vendor/${dir}.tgz`])),
      ...Object.fromEntries(Object.keys(bridgeBinaries).map((name) => [name, "-"])),
    },
  }),
  // Imported by the Sites panel on every page.
  "sites/hello/site.ts": `import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Hello desk" });\n`,
  "sites/hello/routes/run.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "@sanoma-ai/app/ui";
import { Link } from "sanoma/site";

export const Route = createFileRoute("/sites/hello/run")({ component: Run });

function Run() {
  return (
    <div>
      <RunForm workflow="hello" />
      <Link to="/sites/hello">Back to the hello site</Link>
    </div>
  );
}
`,
};

let dir = "";
let server: Awaited<ReturnType<typeof serving>> | undefined;
const stderr = () => server?.output().stderr ?? "";

describe("sanoma from packed tarballs: the dev server", () => {
  beforeAll(async () => {
    ensureBuilt();
    dir = mkdtempSync(join(tmpdir(), "sanoma-packed-"));
    cpSync(fixture, dir, { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    mkdirSync(join(dir, "vendor"));
    // Piped, so a failure's error carries pnpm's message.
    for (const pkg of ["sanoma", ...Object.values(OVERRIDES)]) {
      // Built above: prepack's clean and build would only repeat it.
      execFileSync("pnpm", ["pack", "--config.ignore-scripts=true", "--out", join(dir, "vendor", `${pkg}.tgz`)], {
        cwd: join(checkout, "packages", pkg),
        stdio: "pipe",
      });
    }
    // No lockfile to freeze (CI sets it by default).
    execFileSync("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: dir, stdio: "pipe" });
    server = await serving(dir, [], env, join(dir, "node_modules/sanoma/dist/cli.js"));
  }, 600_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("serves a site's pages and the app's, compiling the app's shipped source from node_modules", async () => {
    const { url } = server!;
    expect(stderr()).toContain("serving the app with 1 site (hello) from Vite's dev server");
    const app = await fetch(`${url}/workflows`);
    expect(app.status, stderr()).toBe(200);
    expect(await app.text()).toContain("Hello desk");
    const site = await fetch(`${url}/sites/hello/run`);
    expect(site.status, stderr()).toBe(200);
    const html = (await site.text()).replaceAll("<!-- -->", "");
    expect(html).toContain("The hello site");
    expect(html).toContain("Back to the hello site");
    expect(stderr()).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  }, 60_000);
});
