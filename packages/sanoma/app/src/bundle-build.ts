// The app bundle's build, Node only (`buildAppBundle`): the app with its sites built once more,
// for Cloudflare's workerd, by `@cloudflare/vite-plugin`, over the same route tree as the Node
// build (`buildApp`). The bundle carries the company's config, the snapshot of its files and the
// runtime, and the pages no call is made from are prerendered into its assets. What needs the
// checkout is the worker's (`steps/`), which no module of the app imports. `sanoma/app/bundle`.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, SourceMap, type SourceMapPayload } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { declarationFiles, filesUnder, type SanomaConfig, timeMatcherFile, vendorInfo } from "sanoma/workflows";
import { domainsText } from "sanoma/workflows/shared";
import type { SiteEntry } from "sanoma/workflows/describe";
import MagicString from "magic-string";
import type { InlineConfig, Plugin, PluginOption } from "vite";
import { type AppBundle, prerenderedAsset } from "./app-bundle.ts";
import {
  appSources,
  companyFile,
  manifestFile,
  pkgDir,
  quietLogger,
  repoConfig,
  sitesOf,
  specifier,
  writeSiteFiles,
} from "./build.ts";
import { type AppSnapshot, servedOnWorker } from "./snapshot.ts";
import { appSnapshot } from "./snapshot-build.ts";

/** The Worker's runtime, as the bundle is built and tested for. */
const COMPATIBILITY_DATE = "2026-10-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * What the runtime imports that the Worker never runs, and the build leaves out, each aliased to
 * `worker/missing.js`, whose every use throws: DBOS's optional dependencies, required lazily only
 * with tracing or OTLP logs on (measured on workerd for #428: DBOSClient bundles without exactly
 * these, and enqueues), and the runtime's source tools, which parse and format the company's files.
 */
const OPTIONAL: readonly string[] = [
  "@opentelemetry/api",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/core",
  "@opentelemetry/exporter-logs-otlp-proto",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/sdk-logs",
  "@opentelemetry/sdk-trace-base",
  "winston",
  "winston-transport",
  "oxc-parser",
  "oxfmt",
];

/**
 * Node's modules workerd has only as stubs, or none at all, with `nodejs_compat`, and its file
 * system, which holds none of the company's files: a site's file or the app's own importing one
 * cannot answer a request on the Worker. (A workflow's or a resource's file may: the bundle
 * imports it for its declarations, and its runs are the worker's, on Node.)
 */
const NODE_ONLY = new Set([
  "child_process",
  "cluster",
  "dgram",
  "fs",
  "fs/promises",
  "inspector",
  "module",
  "readline",
  "repl",
  "sqlite",
  "trace_events",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

/** A site's file, or the app's own, that imports what the Worker does not have (`NODE_ONLY`): the first the build met. */
export class NodeOnlyImport extends Error {
  /** The importing file, from the repo (or the app's own, as `sanoma/app/src/…`). */
  readonly file: string;
  /** What it imports: a name, `default`, `*`, or `the module` for an import of it alone. */
  readonly symbol: string;
  /** From where: `node:child_process`. */
  readonly module: string;

  constructor(file: string, symbol: string, module: string) {
    super(`${file} imports ${symbol} from ${module}, which the Cloudflare Worker does not have`);
    this.name = "NodeOnlyImport";
    this.file = file;
    this.symbol = symbol;
    this.module = module;
  }
}

export interface BuildAppBundleOptions {
  /** The company's config, loaded from its file (`config.file`), which the bundle imports for its workflows and connectors. */
  config: SanomaConfig;
  /**
   * A public site's domain, by site name (`SANOMA_DOMAINS`): the sites with no login whose pages
   * are prerendered, at their domain. A site without one is rendered on each request.
   */
  domains?: Readonly<Record<string, string>>;
  /** See `BuildAppOptions.log`. */
  log?: (line: string) => void;
}

/**
 * The pages of `site` the build prerenders: those no call is made from, on the page or a layout
 * above it. A call from a file that is no page (a component's) may be on any of them: none then.
 */
export function prerenderedPages(site: Pick<SiteEntry, "pages" | "calls">): SiteEntry["pages"] {
  if (site.calls.some((call) => call.page === undefined)) return [];
  const pages = site.calls.map((call) => call.page!);
  return site.pages.filter(({ path }) => !pages.some((page) => path === page || path.startsWith(`${page}/`)));
}

const BUNDLE = "virtual:sanoma/app-bundle";

/** `[[path, <name><i>], …]`, each path beside the module imported from it as `<name><i>`. */
const entries = (paths: string[], name: string) =>
  `[${paths.map((path, i) => `[${JSON.stringify(path)}, ${name}${i}]`).join(", ")}]`;

/**
 * The runtime's registrations, made before any company file is evaluated: the root and its
 * snapshot (`useRootSnapshot`: `appOfFile` finds a file's app by it), Cedar's web build
 * (`useCedarWasm`, initialised on first use) and DBOS's cron parser by its file (`useTimeMatcher`).
 */
const RUNTIME = "virtual:sanoma/app-runtime";

/**
 * `virtual:sanoma/app-runtime`, which `worker/app.ts` imports first, and `virtual:sanoma/app-bundle`,
 * the config as `sanoma` loads it (its file's, with the declaration files joined, `joinDeclarations`).
 */
function bundleModule(root: string, configFile: string, snapshot: AppSnapshot): Plugin {
  const id = `\0${BUNDLE}`;
  const runtimeId = `\0${RUNTIME}`;
  // The runtime's Cedar, its web build beside its Node one (`./web` is import-only, so no require resolves it).
  const fromRuntime = createRequire(manifestFile);
  const cedar = join(dirname(fromRuntime.resolve("@cedar-policy/cedar-wasm/nodejs")), "..", "web");
  return {
    name: "sanoma:app-bundle",
    enforce: "pre",
    resolveId: (source) => (source === BUNDLE ? id : source === RUNTIME ? runtimeId : undefined),
    load(loaded) {
      if (loaded === runtimeId) {
        return [
          'import { useCedarWasm, useRootSnapshot, useTimeMatcher } from "sanoma/workflows";\n',
          `import * as cedarWeb from ${specifier(join(cedar, "cedar_wasm.js"))};\n`,
          `import cedarModule from ${specifier(join(cedar, "cedar_wasm_bg.wasm"))};\n`,
          `import { TimeMatcher } from ${specifier(timeMatcherFile(fromRuntime))};\n`,
          `export const root = ${JSON.stringify(root)};\n`,
          `export const snapshot = JSON.parse(${JSON.stringify(JSON.stringify(snapshot))});\n`,
          "useRootSnapshot(root, snapshot);\n",
          "useCedarWasm(() => (cedarWeb.initSync({ module: cedarModule }), cedarWeb));\n",
          "useTimeMatcher(TimeMatcher);\n",
        ].join("");
      }
      if (loaded !== id) return;
      const files = declarationFiles(root);
      return [
        // First, so the runtime's registrations are made before the config's files are evaluated.
        `import ${JSON.stringify(RUNTIME)};\n`,
        'import { joinDeclarations } from "sanoma/workflows";\n',
        `import config from ${specifier(configFile)};\n`,
        ...files.workflows.map((path, i) => `import * as workflow${i} from ${specifier(path)};\n`),
        ...files.data.map((path, i) => `import * as data${i} from ${specifier(path)};\n`),
        `joinDeclarations(config, { workflows: ${entries(files.workflows, "workflow")}, data: ${entries(files.data, "data")} });\n`,
        "export { config };\n",
      ].join("");
    },
  };
}

/** The Worker's plugins: the bundle's module, the runtime's version and files, DBOS's optional packages stubbed, Node-only imports refused, and Cloudflare's over the ssr environment. */
async function bundlePlugins(root: string, configFile: string, snapshot: AppSnapshot): Promise<PluginOption[]> {
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const { src } = appSources();
  const missing = join(pkgDir, "src", "worker", "missing.js");
  return [
    bundleModule(root, configFile, snapshot),
    {
      // The runtime reads its version from `sanoma`'s package.json, two directories above it: inlined from the build's.
      name: "sanoma:runtime-version",
      enforce: "pre",
      applyToEnvironment: ssr,
      transform(code, id) {
        const file = id.split("?")[0]!;
        if (!/[/\\]workflows[/\\](dist[/\\]version\.js|src[/\\]version\.ts)$/.test(file)) return;
        const read =
          /JSON\.parse\(\s*readFileSync\(new URL\("\.\.\/\.\.\/package\.json", import\.meta\.url\), "utf8"\)\s*\)/;
        if (!read.test(code)) return this.error(`the Worker's build no longer finds how ${file} reads its version`);
        const { version } = JSON.parse(readFileSync(join(dirname(file), "..", "..", "package.json"), "utf8")) as {
          version: string;
        };
        return { code: code.replace(read, JSON.stringify({ version })), map: null };
      },
    },
    {
      // workerd gives a module no `import.meta.url`: each is given its file's, as Node gives it,
      // and what `vendorInfo(import.meta.url)` reads of a connector's package (which the Worker
      // does not have) is read here. A connector's module calls it as it is evaluated.
      name: "sanoma:import-meta-url",
      applyToEnvironment: ssr,
      transform: {
        filter: { id: /\.[cm]?[jt]sx?(\?|$)/, code: "import.meta.url" },
        handler(code, id) {
          const file = id.split("?")[0]!;
          const url = pathToFileURL(file).href;
          const out = new MagicString(code);
          // The call last replaced: its own `import.meta.url`, visited right after it, goes with it.
          let replaced = { start: -1, end: -1 };
          for (const node of nodesOf(this.parse(code, { lang: langOf(file) }))) {
            if (replaced.start <= node.start && node.end <= replaced.end) continue;
            if (node.type === "CallExpression" && isVendorInfo(node)) {
              out.overwrite(node.start, node.end, `(${JSON.stringify(vendorInfo(url))})`);
              replaced = node;
            } else if (isImportMetaUrl(node)) {
              out.overwrite(node.start, node.end, JSON.stringify(url));
            }
          }
          return { code: out.toString(), map: out.generateMap({ hires: true }) };
        },
      },
    },
    {
      // Each company file says it is the one evaluating, for what V8's call sites name in a bundle
      // no longer (`callerFile` in the runtime): a workflow's file, a collection's app.
      name: "sanoma:company-files",
      applyToEnvironment: ssr,
      transform(code, id) {
        const file = id.split("?")[0]!;
        if (!companyFile(id, root) || !/\.[cm]?[jt]sx?$/.test(file)) return;
        const out = new MagicString(code).prepend(`globalThis[Symbol.for("sanoma.file")] = ${JSON.stringify(file)};\n`);
        return { code: out.toString(), map: out.generateMap({ hires: true }) };
      },
    },
    {
      name: "sanoma:optional",
      enforce: "pre",
      applyToEnvironment: ssr,
      resolveId: (source) => (OPTIONAL.includes(source) ? missing : undefined),
    },
    {
      // A site's file or the app's own importing what the Worker lacks, refused by file and symbol.
      name: "sanoma:node-only",
      applyToEnvironment: ssr,
      transform(code, id) {
        const file = id.split("?")[0]!;
        const site =
          companyFile(file, root) && /^(apps\/[^/]+\/)?sites\//.test(relative(root, file).split(sep).join("/"));
        const own = site || file.startsWith(`${src}${sep}`);
        if (!own || !/\.[cm]?[jt]sx?$/.test(file) || !/\bimport\b/.test(code)) return;
        for (const statement of this.parse(code, { lang: file.endsWith("x") ? "tsx" : "ts" }).body as unknown as {
          type: string;
          importKind?: string;
          source?: { value: string };
          specifiers?: { type: string; importKind?: string; imported?: { name?: string; value?: string } }[];
        }[]) {
          if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
          const module = statement.source!.value;
          if (!NODE_ONLY.has(module.replace(/^node:/, ""))) continue;
          const used = statement.specifiers!.find((s) => s.importKind !== "type");
          if (statement.specifiers!.length && !used) continue;
          const symbol =
            used === undefined
              ? "the module"
              : used.type === "ImportDefaultSpecifier"
                ? "default"
                : used.type === "ImportNamespaceSpecifier"
                  ? "*"
                  : (used.imported?.name ?? used.imported?.value ?? "?");
          // Said from the repo, or for the app's own from its package.
          const named = companyFile(file, root) ? relative(root, file) : `sanoma/app/${relative(pkgDir, file)}`;
          throw new NodeOnlyImport(named, symbol, module);
        }
      },
    },
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: false,
      inspectorPort: false,
      config: {
        name: "sanoma-app",
        main: join(src, "worker", "main.ts"),
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: COMPATIBILITY_FLAGS,
      },
    }),
  ];
}

/** A parsed module's node, as far as the Worker's build reads it. */
interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** Every node of a parsed module, parents first. */
function* nodesOf(value: unknown): Generator<AstNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodesOf(item);
  } else if (value !== null && typeof value === "object") {
    if (typeof (value as AstNode).type === "string") yield value as AstNode;
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") yield* nodesOf(child);
  }
}

/** `import.meta.url`. */
const isImportMetaUrl = (node: AstNode) => {
  const { object, property } = node as {
    object?: AstNode & { meta?: { name?: string } };
    property?: { name?: string };
  };
  return (
    node.type === "MemberExpression" &&
    object?.type === "MetaProperty" &&
    object.meta?.name === "import" &&
    property?.name === "url"
  );
};

/** `vendorInfo(import.meta.url)`. */
const isVendorInfo = (node: AstNode) => {
  const { callee, arguments: args } = node as { callee?: AstNode & { name?: string }; arguments?: AstNode[] };
  return (
    callee?.type === "Identifier" && callee.name === "vendorInfo" && args?.length === 1 && isImportMetaUrl(args[0]!)
  );
};

/** The parser's language for a module's file. */
const langOf = (file: string) => extname(file).slice(1).replace(/^[cm]/, "") as "js" | "jsx" | "ts" | "tsx";

/** The Worker's environment: Cloudflare's plugin builds Start's server environment for workerd. */
const ssr = (environment: { name: string }) => environment.name === "ssr";

/** The file at `path` (with `/`) under `dir`, base64. */
const base64 = (dir: string, path: string) => readFileSync(join(dir, ...path.split("/"))).toString("base64");

/** Every file under `dir`, by path from it with `/`. */
const filesIn = (dir: string): string[] =>
  filesUnder(dir, () => true)
    .map((file) => relative(dir, file).split(sep).join("/"))
    .toSorted();

const MODULE_TYPES: Record<string, AppBundle["modules"][number]["type"]> = { js: "esm", mjs: "esm", wasm: "wasm" };

/** The pages to prerender: each public site's with no login, on its domain, that no call is made from. */
function pagesToPrerender(snapshot: AppSnapshot, domains: Readonly<Record<string, string>>) {
  return snapshot.description.sites.flatMap((site) => {
    const domain = domains[site.name]?.toLowerCase();
    // A site with a login shows each visitor their own pages: nothing of it is prerendered.
    if (!servedOnWorker(site) || site.login !== undefined || !domain) return [];
    return { site, domain, pages: prerenderedPages(site) };
  });
}

/** The module the build runs the bundle from, beside its main module: the main module's fetch, a throw answered with its stack. */
const PROBE = "__sanoma_probe.js";

/** The header the probe marks a thrown request's answer with. */
const THROWN = "x-sanoma-thrown";

const probeModule = (main: string) =>
  [
    `import main from ${JSON.stringify(`./${main}`)};\n`,
    "export default {\n",
    "  async fetch(request, env, ctx) {\n",
    "    try {\n",
    "      return await main.fetch(request, env, ctx);\n",
    "    } catch (err) {\n",
    `      return new Response(String(err?.stack ?? err), { status: 500, headers: { ${JSON.stringify(THROWN)}: "1" } });\n`,
    "    }\n",
    "  },\n",
    "};\n",
  ].join("");

/**
 * Where a stack's frames are in the build's own modules, each by its source map: the module's
 * file, from the repo for a company's own, else from its `node_modules` (`@sanoma-ai/…/dist/x.js`),
 * and the line. `top`: whether the frame is a module's own body (V8 names no function there).
 */
function framesOf(stack: string, server: string, root: string): { at: string; top: boolean }[] {
  const frames: { at: string; top: boolean }[] = [];
  // Each module's map, read once: most frames are in the one large chunk.
  const maps = new Map<string, SourceMap | undefined>();
  const mapOf = (file: string) => {
    if (!maps.has(file)) {
      const path = `${file}.map`;
      maps.set(
        file,
        existsSync(path) ? new SourceMap(JSON.parse(readFileSync(path, "utf8")) as SourceMapPayload) : undefined,
      );
    }
    return maps.get(file);
  };
  for (const [, named, url, line, column] of stack.matchAll(
    /^\s*at (?:(.*?) \()?(file:\/\/[^\s)]+):(\d+):(\d+)\)?$/gm,
  )) {
    const file = fileURLToPath(url!);
    const map = file.startsWith(`${server}${sep}`) ? mapOf(file) : undefined;
    if (!map) continue;
    const entry = map.findEntry(Number(line) - 1, Number(column) - 1);
    if (!("originalSource" in entry)) continue;
    const source = entry.originalSource.startsWith("file:")
      ? fileURLToPath(entry.originalSource)
      : resolve(dirname(file), entry.originalSource);
    const module = companyFile(source, root)
      ? relative(root, source).split(sep).join("/")
      : source.split(`${sep}node_modules${sep}`).at(-1)!.split(sep).join("/");
    frames.push({ at: `${module}:${entry.originalLine + 1}`, top: named === undefined });
  }
  return frames;
}

/**
 * What a request the probe answered with a throw says: the module whose evaluation threw (on
 * `loading`, the request that loads the app, when the outermost frame is a module's body), else
 * where it threw, then the error's first line, then each frame of the build's own modules by its source.
 */
function thrownOn(stack: string, server: string, root: string, loading: boolean): Error {
  const frames = framesOf(stack, server, root);
  // A module's evaluation is the outermost frame of a throw as it is evaluated. V8 names no
  // function there, nor in an anonymous one: only the request that loads the app is read so.
  const evaluating = loading && frames.at(-1)?.top ? frames.at(-1) : undefined;
  const where = evaluating
    ? `${evaluating.at} throws as the Cloudflare Worker evaluates it`
    : `the app throws on the Cloudflare Worker${frames[0] ? ` at ${frames[0].at}` : ""}`;
  return new Error([`${where}: ${stack.split("\n")[0]}`, ...frames.map((frame) => `    at ${frame.at}`)].join("\n"));
}

/**
 * Runs the bundle as built on workerd (`unstable_startWorker`), from `PROBE` beside its main
 * module: once to `/healthz`, which loads the app as a Worker's first request does, so a module
 * that throws as it is evaluated (one that needs what workerd does not have, such as Node's
 * `import.meta.url` or a file) fails the build naming it; then each page to prerender, at its
 * site's domain, into `client/` (`prerenderedAsset`). A page renders with no database: the
 * build's DATABASE names none, and a page that would call one is not prerendered.
 */
async function runOnWorkerd(
  root: string,
  server: string,
  client: string,
  main: string,
  targets: ReturnType<typeof pagesToPrerender>,
  published: AppSnapshot["published"],
): Promise<AppBundle["prerendered"]> {
  const { sitemapEntries } = await import("./seo.ts");
  const pages = targets.flatMap(({ site, domain, pages: prerendered }) =>
    sitemapEntries({ ...site, pages: prerendered }, `https://${domain}`, published).map(({ loc }) => ({
      site: site.name,
      domain,
      path: new URL(loc).pathname,
    })),
  );
  const { unstable_startWorker } = await import("wrangler");
  const dir = mkdtempSync(join(tmpdir(), "sanoma-prerender-"));
  const probe = join(server, PROBE);
  try {
    writeFileSync(probe, probeModule(main));
    const config = join(dir, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify({
        name: "sanoma-prerender",
        main: probe,
        compatibility_date: COMPATIBILITY_DATE,
        compatibility_flags: COMPATIBILITY_FLAGS,
        no_bundle: true,
        rules: [
          { type: "ESModule", globs: ["**/*.js"] },
          { type: "CompiledWasm", globs: ["**/*.wasm"] },
        ],
        assets: { directory: client, binding: "ASSETS", html_handling: "none", not_found_handling: "none" },
        vars: {
          SANOMA_DOMAINS: domainsText(Object.fromEntries(targets.map(({ site, domain }) => [site.name, domain]))),
          DATABASE: { connectionString: "postgresql://prerender.invalid/none" },
          // The logins are made with the handler, their keys derived from this; none signs anything a prerendered page holds.
          SANOMA_SIGNING_KEY: randomBytes(32).toString("base64"),
        },
      }),
    );
    const worker = await unstable_startWorker({
      config,
      dev: {
        server: { hostname: "127.0.0.1", port: 0 },
        inspector: false,
        persist: false,
        watch: false,
        // What the build needs of a run it reads from the answers: a throw's stack, a page's status.
        logLevel: "none",
      },
    });
    try {
      await worker.ready;
      const answer = async (url: string, loading = false) => {
        const response = (await worker.fetch(url)) as unknown as Response;
        const text = await response.text();
        if (response.headers.has(THROWN)) throw thrownOn(text, server, root, loading);
        return { response, text };
      };
      // Any host but a site's is the app's.
      const health = await answer("https://app.invalid/healthz", true);
      if (!health.response.ok) {
        throw new Error(
          `the app on the Cloudflare Worker answered /healthz ${health.response.status}: ${health.text.slice(0, 200)}`,
        );
      }
      const rendered: AppBundle["prerendered"] = [];
      for (const page of pages) {
        const { response, text: html } = await answer(`https://${page.domain}${page.path}`);
        if (!response.ok)
          throw new Error(`prerendering ${page.site}${page.path} answered ${response.status}: ${html.slice(0, 200)}`);
        const asset = prerenderedAsset(page.domain, page.path);
        if (!asset) continue;
        const file = join(client, ...asset.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, html);
        rendered.push({ ...page, asset });
      }
      return rendered;
    } finally {
      await worker.dispose();
    }
  } finally {
    rmSync(probe, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the company's app bundle for Cloudflare's Worker (`AppBundle`): every route, the app's
 * and each site's, under the app's `__root.tsx`, bundled with the runtime, the config and the
 * snapshot of the company's files (`appSnapshot`) for workerd by `@cloudflare/vite-plugin`, and
 * every page no call is made from of a public site with no login on a domain (`domains`)
 * prerendered into the assets. Refuses a site's file or the app's own that imports what the
 * Worker does not have (`NodeOnlyImport`). Written under `.sanoma/app/bundle/` and read back,
 * nothing kept.
 */
export async function buildAppBundle(repo: string, options: BuildAppBundleOptions): Promise<AppBundle> {
  const root = realpathSync(repo);
  const { config, log } = options;
  if (!config.file) throw new Error("buildAppBundle needs the config loaded from its file (config.file)");
  // A repo with a site gets the sites' generated files, as `buildApp` writes them; one without, none.
  const { sites, refused } = sitesOf(root);
  if (sites.length) writeSiteFiles(root);
  for (const dir of refused) {
    log?.(`${dir} is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)`);
  }
  const snapshot = await appSnapshot(config);
  const outDir = join(root, ".sanoma", "app", "bundle", `build.${process.pid}.tmp`);
  // Cloudflare's plugin points its own preview at the build through `<root>/.wrangler/deploy`.
  const wrangler = join(root, ".wrangler");
  const hadWrangler = existsSync(wrangler);
  rmSync(outDir, { recursive: true, force: true });
  const vite = await import("vite");
  const built: InlineConfig = {
    ...repoConfig(root, await bundlePlugins(root, config.file, snapshot)),
    build: { outDir, emptyOutDir: true },
    logLevel: "warn",
    customLogger: quietLogger(vite, log),
  };
  try {
    try {
      await (await vite.createBuilder(built)).buildApp();
    } catch (err) {
      throw nodeOnlyOf(err) ?? err;
    }
    const client = join(outDir, "client");
    const server = join(outDir, "server");
    const { main } = JSON.parse(readFileSync(join(server, "wrangler.json"), "utf8")) as { main: string };
    const prerendered = await runOnWorkerd(
      root,
      server,
      client,
      main,
      pagesToPrerender(snapshot, options.domains ?? {}),
      snapshot.published,
    );
    return {
      version: snapshot.version,
      mainModule: main,
      modules: filesIn(server)
        // The modules; not the stylesheets and fonts the server's build emits beside them, which the client's has.
        .flatMap((name) => {
          const type = MODULE_TYPES[name.split(".").at(-1)!];
          return type ? [{ name, type, content: base64(server, name) }] : [];
        }),
      assets: filesIn(client)
        .filter((path) => path !== "wrangler.json" && path !== ".assetsignore")
        .map((path) => {
          const content = base64(client, path);
          return {
            path: `/${path}`,
            content,
            // Cloudflare's: the first 32 hex digits of the SHA-256 of the base64 and the extension.
            hash: createHash("sha256")
              .update(content + extname(path).slice(1))
              .digest("hex")
              .slice(0, 32),
            size: Buffer.byteLength(content, "base64"),
          };
        }),
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: [...COMPATIBILITY_FLAGS],
      prerendered,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    if (!hadWrangler) rmSync(wrangler, { recursive: true, force: true });
  }
}

/** The `NodeOnlyImport` an error is, or holds: Rolldown gathers a build's errors in `errors`, a plugin's among them. */
function nodeOnlyOf(err: unknown): NodeOnlyImport | undefined {
  if (err instanceof NodeOnlyImport) return err;
  const { errors, cause } = (err ?? {}) as { errors?: unknown; cause?: unknown };
  for (const inner of [...(Array.isArray(errors) ? errors : []), cause]) {
    const found = inner === undefined ? undefined : nodeOnlyOf(inner);
    if (found) return found;
  }
  return undefined;
}
