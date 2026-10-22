import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, repo as checkout, serving } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`), the packages' builds, and pnpm with the registry or a warm store
// (`--prefer-offline`): with no lockfile, the company's third-party dependencies resolve as a
// customer's do. This checkout's packages install as tarballs, under node_modules as from npm,
// where a linked checkout would hide issue #220; the installed bin runs the dev server.
// No SANOMA_DEV_REPO from the shell: the bin as installed, not in dev mode.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-packed"), SANOMA_APP_PORT: "0", SANOMA_DEV_REPO: "" };
const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

const manifest = (dir: string) => JSON.parse(readFileSync(join(checkout, "packages", dir, "package.json"), "utf8"));

/** `sanoma`'s dependencies in this workspace, `@sanoma-ai/<dir>` each: packed, as `sanoma` is, into `vendor/<dir>.tgz`. */
const workspace = Object.entries(manifest("sanoma").dependencies as Record<string, string>)
  .filter(([, range]) => range.startsWith("workspace:"))
  .map(([name]) => name.replace("@sanoma-ai/", ""));

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "packed-company",
    private: true,
    type: "module",
    dependencies: { sanoma: "file:vendor/sanoma.tgz" },
    // The checkout's pnpm, whose pnpm-workspace.yaml overrides (and "-") these rely on.
    packageManager: JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).packageManager,
  }),
  // sanoma's dependencies on the others are by version: these tarballs instead of npm's. The
  // bridge's binaries stay out (the dev server does not start it).
  "pnpm-workspace.yaml": JSON.stringify({
    overrides: {
      ...Object.fromEntries(workspace.map((dir) => [`@sanoma-ai/${dir}`, `file:vendor/${dir}.tgz`])),
      ...Object.fromEntries(Object.keys(manifest("bridge").optionalDependencies).map((name) => [name, "-"])),
    },
  }),
  // Imported by the Sites panel on every page.
  "sites/hello/site.ts": `import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Hello desk" });\n`,
  "sites/hello/routes/run.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "sanoma/ui";
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
    // Built above: prepack's clean and build would only repeat it. A failure's error carries pnpm's message.
    await Promise.all(
      ["sanoma", ...workspace].map((pkg) =>
        run("pnpm", ["pack", "--config.ignore-scripts=true", "--out", join(dir, "vendor", `${pkg}.tgz`)], {
          cwd: join(checkout, "packages", pkg),
        }),
      ),
    );
    // No lockfile to freeze (CI sets it by default).
    await run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: dir });
    server = await serving(dir, [], env, join(dir, "node_modules/sanoma/dist/cli.js"));
  }, 600_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("serves a site's pages and the app's, compiling the app's shipped source from node_modules, and its content", async () => {
    const { url } = server!;
    expect(stderr()).toContain("serving the app with 1 site (hello) from Vite's dev server");
    const app = await fetch(`${url}/workflows`);
    expect(app.status, stderr()).toBe(200);
    expect(await app.text()).toContain("Hello desk");
    const site = await fetch(`${url}/sites/hello/run`);
    expect(site.status, stderr()).toBe(200);
    const html = (await site.text()).replaceAll("<!-- -->", "");
    expect(html).toContain("The hello site");
    // RunForm, from sanoma/ui as the tarball ships it.
    expect(html).toContain("Starts a live run of hello.");
    expect(html).toContain("Back to the hello site");
    // The fixture's content/, read and rendered by marked and yaml as installed from the tarballs.
    const post = (await (await fetch(`${url}/sites/hello/post`)).text()).replaceAll("<!-- -->", "");
    expect(post).toContain("<h3>The first post</h3>");
    expect(post).toContain("Read from <strong>content/posts/hello.md</strong>.");
    expect(stderr()).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  }, 60_000);
});
