import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDemo, DemoRefused, demoPlan } from "sanoma/app/demo";
import { resend } from "@sanoma-ai/connector-resend";
import { defineConnector } from "sanoma/workflows";
import { executablePath, launch as launchChrome } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.ts";

// `sanoma demo` (`buildDemo`) of a company shaped as the invoicing app's: an app's site starting
// an app's workflow that reads the company's and the app's collections, emails a PDF through
// Resend's fake, sleeps a week and reminds, and renders a PDF in the page by a dynamic import.
// The demo is built once, then served as a host's page serves it, and driven in Chrome.
const fixture = fileURLToPath(new URL("./fixtures/company-demo/", import.meta.url));
const sanomaDir = fileURLToPath(new URL("../..", import.meta.url));
const resendDir = fileURLToPath(new URL("../../../../connectors/resend", import.meta.url));
const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture, with sanoma and Resend's connector installed as a company installs them; `edit` changes it first. */
function company(edit?: (repo: string) => void): string {
  const repo = mkdtempSync(join(tmpdir(), "sanoma-demo-"));
  temporary.push(repo);
  cpSync(fixture, repo, { recursive: true });
  mkdirSync(join(repo, "node_modules", "@sanoma-ai"), { recursive: true });
  symlinkSync(sanomaDir, join(repo, "node_modules", "sanoma"));
  symlinkSync(resendDir, join(repo, "node_modules", "@sanoma-ai", "connector-resend"));
  edit?.(repo);
  return repo;
}

const build = async (repo: string, out = join(repo, "demo")) => {
  const { config } = await loadConfig(repo);
  return { out, ...(await buildDemo(repo, { config, out })) };
};

/** A site `www` whose page calls `target`. */
const call = (target: string, kind: "workflow" | "op" = "workflow") => ({
  name: "www",
  calls: [{ kind, target, via: "api" as const, file: "sites/www/routes/index.tsx", line: 3, column: 7 }],
});

/** What `fn` refused, which it must. */
const refusals = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DemoRefused) return err.reasons;
    throw err;
  }
  throw new Error("not refused");
};

describe("demoPlan", () => {
  const root = "/acme";
  const configFile = "/acme/sanoma.config.ts";
  const send = { name: "invoice-send", file: "/acme/workflows/invoice-send.ts", uses: [resend.emails.send] };
  const plan = (sites: Parameters<typeof demoPlan>[0]["sites"], extra: Partial<Parameters<typeof demoPlan>[0]> = {}) =>
    demoPlan({
      root,
      configFile,
      sites,
      workflows: [send],
      connectors: [resend],
      fakes: new Set(["resend"]),
      collections: new Set(["invoices"]),
      ...extra,
    });

  it("bundles the workflows the sites call, by name or api name, and the connectors they use", () => {
    expect(plan([call("invoiceSend")])).toEqual({
      workflows: [send],
      connectors: [{ connector: resend, package: "@sanoma-ai/connector-resend" }],
    });
    expect(plan([]).workflows).toEqual([]);
  });

  it("refuses, at the file, a workflow defined in the config, the app's own operations, and a vendor it cannot fake or import", () => {
    const local = defineConnector("ghost", {
      post: { create: { effect: "write", input: z.object({}), output: z.object({}) } },
    });
    expect(refusals(() => plan([call("invoice-send")], { workflows: [{ ...send, file: configFile }] }))).toEqual([
      "sites/www/routes/index.tsx:3: invoice-send is defined in sanoma.config.ts: a demo bundles a workflow from its own file, under workflows/",
    ]);
    expect(refusals(() => plan([call("sanoma.apps.list", "op"), call("nothing")]))).toEqual([
      "sites/www/routes/index.tsx:3: sanoma.apps.list is the app's own, which a demo has none of",
      "sites/www/routes/index.tsx:3: calls nothing, which is no workflow of the config's",
    ]);
    expect(
      refusals(() => plan([{ name: "www", calls: [{ ...call("clients").calls[0]!, kind: "collection" as const }] }])),
    ).toEqual([
      "sites/www/routes/index.tsx:3: reads clients, a collection no data file under resources/ exports, which a demo bundles its collections from",
    ]);
    expect(refusals(() => plan([call("invoiceSend")], { fakes: new Set() }))).toEqual([
      "workflows/invoice-send.ts: uses resend, whose connector attaches no fake, which a demo runs every vendor on",
    ]);
    expect(
      refusals(() =>
        plan([call("ghost.post.create", "op")], { connectors: [resend, local], fakes: new Set(["resend", "ghost"]) }),
      ),
    ).toEqual([
      "sites/www/routes/index.tsx:3: uses ghost, whose connector names no package (info.package) for the page to import it from",
    ]);
    expect(
      refusals(() =>
        plan([], { world: { name: "w", given: [{ step: "Given", op: "stripe.charge.create", input: {} }] } }),
      ),
    ).toEqual(["scenarios/world.feature: uses stripe, but the config has no connector for it"]);
  });
});

describe("buildDemo", () => {
  let out: string;
  let files: string[];
  beforeAll(async () => {
    ({ out, files } = await build(company()));
  }, 300_000);

  it("writes mount.js, its chunks, demo.css and index.html, every URL relative and no path of the machine's", () => {
    expect(files).toEqual(expect.arrayContaining(["mount.js", "demo.css", "index.html"]));
    expect(
      files.filter((file) => !/^(mount\.js|demo\.css|index\.html|chunks\/.+\.js|files\/.+\.\w+)$/.test(file)),
    ).toEqual([]);
    /** Each text file's match of `pattern`, with what is around it. */
    const found = (pattern: RegExp) =>
      files
        .filter((file) => /\.(js|css|html)$/.test(file))
        .flatMap((file) => {
          const text = readFileSync(join(out, file), "utf8");
          const at = text.search(pattern);
          return at < 0 ? [] : [`${file}: ${text.slice(Math.max(0, at - 60), at + 60)}`];
        });
    // Served from any folder: a site's public/demos/<name>/.
    expect(found(/["'(]\/(assets|chunks|files)\/|url\(\.\.\//)).toEqual([]);
    expect(found(new RegExp(`${RegExp.escape(sanomaDir)}|${RegExp.escape(tmpdir())}`))).toEqual([]);
    const css = readFileSync(join(out, "demo.css"), "utf8");
    // Scoped to the element, and no preflight's reset of the host's page.
    expect(css).toContain("[data-sanoma-demo]");
    expect(css).toContain("invoice-title");
    expect(css).not.toMatch(/(^|[},])\s*(html|body|\*|:root)\s*[,{]/);
    // The light theme only: a `.dark` turns the kit's dark styles on inside the element, never the host's own.
    expect(css).not.toMatch(/[(,]\.dark[ ),]/);
  });

  it("refuses a world its fakes cannot take, with the world's own message, a page that would load Node, and a folder of other files", async () => {
    const ghost = company((repo) =>
      writeFileSync(
        join(repo, "scenarios", "world.feature"),
        'Feature: World\n  Scenario: Nothing\n    Given data.nothing "x" has\n      | client | Nobody |\n',
      ),
    );
    await expect(build(ghost)).rejects.toThrow('scenarios/world.feature:3: no resource type "data.nothing"');
    const node = company((repo) =>
      writeFileSync(
        join(repo, "apps", "invoicing", "sites", "invoicing", "routes", "disk.tsx"),
        'import { createFileRoute } from "@tanstack/react-router";\nimport { readFileSync } from "node:fs";\n' +
          'export const Route = createFileRoute("/sites/invoicing/invoicing/disk")({ component: () => String(readFileSync) });\n',
      ),
    );
    await expect(build(node)).rejects.toThrow(/only a server has: .*fs/);
    // A folder holding what no demo writes is never emptied.
    const busy = company();
    mkdirSync(join(busy, "demo"));
    writeFileSync(join(busy, "demo", "robots.txt"), "");
    await expect(build(busy)).rejects.toThrow(/holds robots\.txt, and no demo's alone/);
  }, 300_000);

  it("runs in a dark host's page: a workflow from the page, a failure said, a PDF rendered, a toast, the light look, a fresh world on remount, nothing leaving the page", async (ctx) => {
    const chrome = process.env.CHROME_PATH ?? (await executablePath("chrome").catch(() => ""));
    if (!existsSync(chrome)) ctx.skip("no Chrome: install Google Chrome or set CHROME_PATH");
    const server = await host(out);
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await launchChrome({ executablePath: chrome, headless: true });
    try {
      const tab = await browser.newPage();
      const requests: string[] = [];
      tab.on("request", (request) => void requests.push(request.url()));
      const errors: string[] = [];
      tab.on("pageerror", (err) => void errors.push(String(err)));
      tab.on("console", (message) => void (message.type() === "error" && errors.push(message.text())));
      await tab.goto(`${origin}/`);
      await tab.waitForFunction("window.mounted");
      const said = async (button: string, text: RegExp) => {
        await tab.locator(`::-p-text(${button})`).click();
        await tab
          .waitForFunction(`${text}.test(document.querySelector("output")?.textContent ?? "")`, { timeout: 60_000 })
          .catch(async (err: unknown) => {
            const shown = await tab.evaluate(`document.querySelector("#demo")?.textContent`);
            throw new Error(`${button}: ${String(err)}; the demo shows ${shown}; errors: ${errors.join("; ")}`);
          });
      };
      await said("Send draft-1", /Sent INV-0001, reminded true after 7 days/);
      await said("Send nothing", /Refused: No invoice nothing/);
      await said("Render a PDF", /PDF invoice-INV-0001\.pdf rendered/);
      // A toast shows, inside the demo's element.
      await tab.locator("::-p-text(Toast)").click();
      await tab.waitForFunction(`document.querySelector("#demo [data-sonner-toast]")?.textContent.includes("Toasted")`);
      // The element has a bare demo element's look, not the dark serif host's.
      const [bare, shown] = (await tab.evaluate(`(() => {
        const probe = document.createElement("div");
        probe.setAttribute("data-sanoma-demo", "");
        document.documentElement.append(probe);
        const looks = [probe, document.querySelector("#demo")].map((element) => {
          const { backgroundColor, color, fontFamily } = getComputedStyle(element);
          return { backgroundColor, color, fontFamily };
        });
        probe.remove();
        return looks;
      })()`)) as Record<string, string>[];
      expect(bare).toMatchObject({
        backgroundColor: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/),
        fontFamily: expect.stringContaining("IBM Plex Sans"),
      });
      expect(shown).toEqual(bare);
      // Mounted again: the world as it began, so the number is the first again.
      await tab.evaluate("window.remount()");
      await said("Send draft-1", /Sent INV-0001/);
      // A link out of the sites is the host's to follow: the host's URL never moved.
      await tab.locator("::-p-text(The app)").click();
      await tab.waitForFunction(`window.exited === "/workflows"`);
      expect(await tab.evaluate("location.href")).toBe(`${origin}/`);
      // The site's start form, drawn from the workflow's schema in the config the demo carries: a run started in the page.
      await tab.goto(`${origin}/?path=/sites/invoicing/invoicing`);
      await tab.locator("::-p-text(Starts a live run of invoicing.invoice-send)").wait();
      await tab.locator("input").fill("draft-1");
      await tab.locator("::-p-text(Start run)").click();
      await tab.locator("::-p-text(Run started.)").wait();
      expect(errors).toEqual([]);
      // The page's own origin, or what the page holds (a data: URL, React-pdf's inlined layout engine).
      expect(requests.filter((url) => !url.startsWith(`${origin}/`) && !/^(data|blob):/.test(url))).toEqual([]);
    } finally {
      await browser.close();
      server.close();
    }
  }, 300_000);
});

/** A host's page at `/` that mounts the demo served from `/demo/` (as a site's public folder serves it), on the tool page unless `?path=` says. */
const HOST = `<!doctype html>
<html><head><link rel="stylesheet" href="/demo/demo.css"></head>
<body class="dark" style="background: #000; color: #fff; font-family: serif"><h1>Host</h1><div id="demo"></div>
<script type="module">
  import { mount } from "/demo/mount.js";
  const element = document.getElementById("demo");
  const path = new URLSearchParams(location.search).get("path") ?? "/sites/invoicing/invoicing/tool";
  const options = { path, exit: (path) => (window.exited = path) };
  let unmount = await mount(element, options);
  window.remount = async () => { unmount(); unmount = await mount(element, options); };
  window.mounted = true;
</script></body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
};

/** Serves `HOST` at `/` and the demo's files under `/demo/`. */
function host(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://host").pathname;
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(HOST);
    if (path === "/favicon.ico") return void res.writeHead(204).end();
    const file = normalize(join(dir, path.replace(/^\/demo\//, "")));
    if (!path.startsWith("/demo/") || !file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}
