import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt as ensure, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, repo as checkout, startCli } from "./fixture.ts";

// Needs Postgres (`pnpm db:up`), the packages' builds, and pnpm with the registry or a warm store
// (`--prefer-offline`): the company's third-party dependencies install as a customer's do. The
// fixture's site with a `site.ts` and a page importing `sanoma/site` and the kit, installed from
// this checkout's packages packed into tarballs, under pnpm's strict layout, so the app's source
// sits under node_modules as it does from npm (a linked checkout does not, and hides what Node
// refuses there: issue #220). The installed bin serves it from Vite's dev server.
const env = { SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-packed"), SANOMA_APP_PORT: "0" };
const fixture = fileURLToPath(new URL("./fixtures/sites/", import.meta.url));

/** The packages `sanoma` installs from this checkout, by their directories: each packed into `vendor/<dir>.tgz`. */
const PACKED = {
  sanoma: "sanoma",
  "@sanoma-ai/app": "app",
  "@sanoma-ai/workflows": "workflows",
  "@sanoma-ai/bridge": "bridge",
};

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "packed-company",
    private: true,
    type: "module",
    dependencies: { sanoma: "file:vendor/sanoma.tgz" },
  }),
  // sanoma's dependencies on the others are by version: these tarballs instead of npm's. The
  // bridge's binaries stay out (the dev server does not start it).
  "pnpm-workspace.yaml": `overrides:\n${Object.entries(PACKED)
    .filter(([name]) => name !== "sanoma")
    .map(([name, dir]) => `  "${name}": file:vendor/${dir}.tgz\n`)
    .join("")}${["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
    .map((platform) => `  "@sanoma-ai/bridge-${platform}": "-"\n`)
    .join("")}`,
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

const dir = mkdtempSync(join(tmpdir(), "sanoma-packed-"));
let url = "";
let running: ReturnType<typeof startCli> | undefined;
const stderr = () => running?.output().stderr ?? "";

describe("sanoma from packed tarballs: the dev server", () => {
  beforeAll(async () => {
    ensureBuilt();
    ensure(join(checkout, "packages/bridge"), ["dist/index.js"], ["pnpm", "run", "build"]);
    cpSync(fixture, dir, { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    mkdirSync(join(dir, "vendor"));
    for (const pkg of Object.values(PACKED)) {
      // Built above: prepack's clean and build would only repeat it.
      execFileSync("pnpm", ["pack", "--config.ignore-scripts=true", "--out", join(dir, "vendor", `${pkg}.tgz`)], {
        cwd: join(checkout, "packages", pkg),
        stdio: "ignore",
      });
    }
    // No lockfile to freeze (CI sets it by default).
    execFileSync("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: dir, stdio: "ignore" });

    running = startCli(dir, [], env, join(dir, "node_modules/sanoma/dist/cli.js"));
    const listening = / at (http:\/\/127\.0\.0\.1:\d+); ctrl-c to stop/;
    try {
      const stdout = await waitFor(
        () => running!.output().stdout,
        (out) => listening.test(out),
        60_000,
      );
      url = stdout.match(listening)![1]!;
    } catch (err) {
      throw new Error(stderr(), { cause: err });
    }
  }, 600_000);

  afterAll(async () => {
    try {
      if (running) {
        running.child.kill("SIGINT");
        const done = await running.finished;
        if (done.code !== 0) throw new Error(`sanoma exited with ${done.code}: ${done.stderr}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("serves a site's pages and the app's, compiling the app's shipped source from node_modules", async () => {
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
