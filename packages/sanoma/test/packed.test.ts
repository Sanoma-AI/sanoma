import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, repo as checkout, serving } from "./fixture.ts";
import { gitIdentity } from "./git.ts";

// Needs Postgres (`pnpm db:up`), the packages' builds, and pnpm with the registry or a warm store
// (`--prefer-offline`): with no lockfile, the company's third-party dependencies resolve as a
// customer's do. This checkout's packages install as tarballs, under node_modules as from npm,
// where a linked checkout would hide issue #220; the installed bin runs the dev server.
// No SANOMA_DEV_REPO from the shell: the bin as installed, not in dev mode.
const env = {
  SANOMA_DATABASE_URL: testDatabaseUrl("sanoma-packed"),
  SANOMA_APP_PORT: "0",
  SANOMA_DEV_REPO: "",
  // The chat's model has no key: none from the shell.
  ANTHROPIC_API_KEY: "",
  // A chat's draft commits as someone.
  ...gitIdentity(),
};
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
    // A Tailwind plugin, whose peer is `tailwindcss`: the company installs no Tailwind of its own.
    // And the template's model connector, as a new company installs it.
    dependencies: {
      sanoma: "file:vendor/sanoma.tgz",
      "@sanoma-ai/connector-anthropic": "file:vendor/connector-anthropic.tgz",
      "@tailwindcss/typography": "0.5.20",
    },
    // The checkout's pnpm, whose pnpm-workspace.yaml overrides (and "-") these rely on.
    packageManager: JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).packageManager,
  }),
  // sanoma's dependencies on the others are by version: these tarballs instead of npm's. The
  // bridge's binaries and PostgreSQL's stay out (the dev server does not start the bridge, and
  // SANOMA_DATABASE_URL names the test database).
  "pnpm-workspace.yaml": JSON.stringify({
    // The plugin's peer is the company's to install, as by default: none here.
    autoInstallPeers: false,
    // As the template's: the build scripts of Pi's model providers, which pnpm 11 would stop on.
    allowBuilds: { "@google/genai": false, protobufjs: false },
    overrides: {
      ...Object.fromEntries(workspace.map((dir) => [`@sanoma-ai/${dir}`, `file:vendor/${dir}.tgz`])),
      ...Object.fromEntries(
        [manifest("bridge"), manifest("sanoma")].flatMap((m) =>
          Object.keys(m.optionalDependencies).map((name) => [name, "-"]),
        ),
      ),
    },
  }),
  // The template's model connector: the chat's model, its key not set yet.
  "sanoma.config.ts": readFileSync(join(fixture, "sanoma.config.ts"), "utf8")
    .replace("import hello", 'import { anthropic } from "@sanoma-ai/connector-anthropic";\nimport hello')
    .replace("connectors: []", "connectors: [anthropic]"),
  // The site's stylesheet with a plugin, as the README's recipe has it.
  "sites/hello/style.css": `${readFileSync(join(fixture, "sites/hello/style.css"), "utf8")}@plugin "@tailwindcss/typography";\n`,
  // Imported by the Sites panel on every page.
  "sites/hello/site.ts": `import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Hello desk" });\n`,
  "sites/hello/routes/run.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Link, RunForm } from "sanoma/site";
import { Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/hello/run")({ component: Run });

function Run() {
  return (
    <Region title="Greet someone">
      <p className="prose">Fill in the form.</p>
      <RunForm workflow="hello" />
      <Link to="/sites/hello">Back to the hello site</Link>
    </Region>
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
    const pack = (from: string, name: string) =>
      run("pnpm", ["pack", "--config.ignore-scripts=true", "--out", join(dir, "vendor", `${name}.tgz`)], {
        cwd: join(checkout, from),
      });
    await Promise.all([
      ...["sanoma", ...workspace].map((pkg) => pack(join("packages", pkg), pkg)),
      pack("connectors/anthropic", "connector-anthropic"),
    ]);
    // No lockfile to freeze (CI sets it by default).
    await run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: dir });
    // pnpm's hidden hoist, where Node would find the plugin's peer by chance: without it, nowhere.
    rmSync(join(dir, "node_modules/.pnpm/node_modules/tailwindcss"), { recursive: true, force: true });
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
    // RunForm from sanoma/site, in a Region from sanoma/ui, as the tarball ships them.
    expect(html).toContain("Greet someone");
    expect(html).toContain("Starts a live run of hello.");
    expect(html).toContain("Back to the hello site");
    // The fixture's content/, read and rendered by marked and yaml as installed from the tarballs.
    const post = (await (await fetch(`${url}/sites/hello/post`)).text()).replaceAll("<!-- -->", "");
    expect(post).toContain("<h3>The first post</h3>");
    expect(post).toContain("Read from <strong>content/posts/hello.md</strong>.");
    expect(stderr()).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  }, 60_000);

  it("starts the chat saying to connect a model, linking to the Anthropic connector's page, until its key is set", async () => {
    const { url } = server!;
    const html = (await (await fetch(`${url}/workflows`)).text()).replaceAll("<!-- -->", "");
    expect(html, stderr()).toMatch(
      /Connect a model to start: <a[^>]*href="\/connectors\/anthropic"[^>]*>set its key on the Anthropic connector page<\/a>/,
    );
    const page = await fetch(`${url}/connectors/anthropic`);
    expect(page.status, stderr()).toBe(200);
    expect(await page.text()).toContain("<code>ANTHROPIC_API_KEY</code>");
  }, 60_000);

  it("builds a site's stylesheet whose @plugin imports tailwindcss/plugin, from the app's Tailwind", async () => {
    // Node, as the bin runs (no NODE_PATH), finds no tailwindcss from the plugin.
    const resolving = run(process.execPath, ["-e", 'require.resolve("tailwindcss/plugin")'], {
      cwd: realpathSync(join(dir, "node_modules/@tailwindcss/typography")),
      env: { ...process.env, NODE_PATH: "" },
    });
    await expect(resolving).rejects.toThrow(/Cannot find module 'tailwindcss\/plugin'/);
    const { url } = server!;
    const html = await (await fetch(`${url}/sites/hello/run`)).text();
    const href = html.match(/<link[^>]*href="(\/sites\/hello\/style\.css[^"]*)"/)?.[1];
    expect(href).toBeDefined();
    const css = await fetch(`${url}${href}`, { headers: { accept: "text/css" } });
    expect(css.status, stderr()).toBe(200);
    // The typography plugin's class, in the site's own layer.
    expect(await css.text()).toMatch(/@layer utilities\.hello\b[\s\S]*\.prose \{/);
  }, 60_000);

  // The chat's third engine as a company runs it: OpenCode installed on first use under the
  // company's .sanoma/agent-home, on its free model, in a draft of the company's own repository.
  it.runIf(process.env.SANOMA_LIVE === "1")(
    "runs a chat turn on a person's own OpenCode, which drafts the A4 request, with the draft card",
    async () => {
      const git = (...args: string[]) => run("git", args, { cwd: dir, env: { ...process.env, ...env } });
      writeFileSync(
        join(dir, "workflows/offboarding.ts"),
        `import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "offboarding",
  title: "Offboard someone",
  trigger: "manual",
  input: z.object({ person: z.string().min(1) }),
  uses: [],
  run: async (ctx, { person }) => ({ done: [\`Removed \${person}'s accounts\`] }),
});
`,
      );
      writeFileSync(join(dir, ".gitignore"), ".sanoma/\nnode_modules/\nvendor/\n");
      await git("init", "--quiet", "--initial-branch=main");
      await git("add", "--all");
      await git("commit", "--quiet", "-m", "First");
      const { url } = server!;
      const started = Date.now();
      const id = `packed-${Date.now()}`;
      const text =
        "Add a laptop step to offboarding: in workflows/offboarding.ts, add `Collected ${person}'s laptop` to the done list.";
      const response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url, "x-sanoma-actor": "ada" },
        body: JSON.stringify({
          id,
          engine: "acp-opencode",
          message: { id: `m-${id}`, role: "user", parts: [{ type: "text", text }] },
        }),
      });
      expect(response.status, stderr()).toBe(200);
      // The reply's stream, read to its end: its draft card among its chunks.
      const chunks = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; data?: unknown });
      console.log(
        `OpenCode in a packed company: the first turn, its install included, took ${Date.now() - started} ms`,
      );
      expect(chunks.find((chunk) => chunk.type === "data-draft")?.data, stderr()).toMatchObject({
        branch: `draft/${id}`,
        files: ["workflows/offboarding.ts"],
      });
      const { stdout } = await git("show", `draft/${id}:workflows/offboarding.ts`);
      expect(stdout).toContain("laptop");
    },
    900_000,
  );
});
