// The app's build, Node only: the package's own (`vite.config.ts`), and a company repo's with its
// sites, the app's routes plus every `sites/<name>/routes` as one TanStack Start build under
// `<repo>/.sanoma/app`. Nothing is written into the app package or under `node_modules`. Only
// Node's modules (and `@sanoma-ai/workflows/shared`, plain values) load with this file; Vite and
// its plugins load when a config or build needs them.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { problemLine, SITE_NAME } from "@sanoma-ai/workflows/shared";
import type { InlineConfig, Logger, Plugin, ViteDevServer } from "vite";
import { CONTENT_TYPES, type ContentProblem, contentTypes, readContent } from "./content-files.ts";
import type { ServerEntry } from "./context.ts";

export { CONTENT_TYPES, type ContentProblem, contentTypes, readContent } from "./content-files.ts";

/** The app package's directory, by its real path (not the symlink pnpm makes): from `src/` or `dist/`. */
const pkgDir = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// The runtime and what it loads stay outside the server bundle: the server imports them from the
// consumer's install, so the app and the worker share one copy. (The app imports no connector; a
// config's connectors reach it only through startApp.)
const RUNTIME = ["@sanoma-ai/workflows", "@sanoma-ai/bridge", "@dbos-inc/dbos-sdk", "pg", "zod"];
const isRuntime = (id: string) => RUNTIME.some((name) => id === name || id.startsWith(`${name}/`));

// The browser bundle may import only types from the runtime (DBOS, Postgres), and the values of
// `@sanoma-ai/workflows/shared`. `import type` is erased before resolution, so anything else of
// these reaching the client is a mistake: fail, in dev as in the build. (Start adds these to its
// own denials, and to the modules marked server-only, such as server/core.ts.)
const CLIENT_DENIED = /^(@sanoma-ai\/(workflows(?!\/shared$)|bridge|connector-|testing)|@dbos-inc\/|pg$)/;

/** What a company file may import without the company depending on it: the app's own copy, so there is one. */
const SHARED = /^(react|react-dom|@tanstack\/[^/]+|@sanoma-ai\/app)(\/.*)?$/;

/**
 * `sites/__virtual.ts`, committed and never edited by hand: the sites mount's listing, every
 * folder with a `routes/` and a URL-segment name (as `sitesOf`), re-read by the route generator on
 * any change under `sites/`. It imports only Node's modules, since a company repo cannot import
 * TanStack's (pnpm installs them beside the app, not in the repo).
 */
const SITES_VIRTUAL = `// Written by sanoma: the sites the app mounts under /sites. Do not edit.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default () =>
  readdirSync(here, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /${SITE_NAME.source}/.test(d.name) && existsSync(join(here, d.name, "routes")))
    .map((d) => ({ type: "physical" as const, directory: \`\${d.name}/routes\`, pathPrefix: \`/\${d.name}\` }));
`;

/** The app's source and the compiler options a site is checked with, by real path. */
export function appSources(): { src: string; tsconfig: string } {
  return { src: join(pkgDir, "src"), tsconfig: join(pkgDir, "tsconfig.site.json") };
}

/** A repo's sites: folders under `sites/` with a `routes/`, and those refused for a name that is not a URL segment. */
export function sitesOf(repo: string): { sites: string[]; refused: string[] } {
  const dir = join(repo, "sites");
  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "routes")))
        .map((d) => d.name)
        .toSorted()
    : [];
  return {
    sites: folders.filter((name) => SITE_NAME.test(name)),
    refused: folders.filter((name) => !SITE_NAME.test(name)),
  };
}

/**
 * Writes the sites' generated files: `sites/__virtual.ts`, `.sanoma/app/tsconfig.json` (the route
 * generator reads `sites/tsconfig.json`, and so the file it extends, when it loads the listing)
 * and `.sanoma/content.ts` (`contentTypes`, drafts included) when missing or different,
 * `sites/tsconfig.json` when missing. An unchanged file is not rewritten: a running dev server
 * reloads every page when one does. `problems`: what is wrong under `content/`.
 */
export function writeSiteFiles(repo: string): { problems: ContentProblem[] } {
  const root = realpathSync(repo);
  const sites = join(root, "sites");
  const out = join(root, ".sanoma", "app");
  mkdirSync(sites, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeChanged(join(sites, "__virtual.ts"), SITES_VIRTUAL);
  const sitesTsconfig = join(sites, "tsconfig.json");
  if (!existsSync(sitesTsconfig)) writeFileSync(sitesTsconfig, '{ "extends": "../.sanoma/app/tsconfig.json" }\n');
  writeChanged(join(out, "tsconfig.json"), `${JSON.stringify(siteTsconfig(root), null, 2)}\n`);
  // Everything under .sanoma/app is generated. Tailwind's scan of the repo honours a .gitignore
  // inside or outside git, so it never reads a build's own output (the server pass would see the
  // client's and make a stylesheet of another hash), whatever the repo's .gitignore says.
  writeChanged(join(out, ".gitignore"), "*\n");
  return { problems: writeContentTypes(root).problems };
}

/** Writes `.sanoma/content.ts` from the content, drafts included, when it changed; the content as read. */
function writeContentTypes(root: string): ReturnType<typeof readContent> {
  const read = readContent(root, { drafts: true });
  writeChanged(join(root, CONTENT_TYPES), contentTypes(read.kinds));
  return read;
}

function writeChanged(file: string, text: string): void {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}

/**
 * `.sanoma/app/tsconfig.json`: the app's compiler options, with the app's own copies of React,
 * TanStack and the app for a site's imports (the company does not install them), and the app
 * router's `#/routeTree.gen.ts` the one in `.sanoma/app`, so links are typed across the app and
 * every site (`paths` win over the app's `imports`, and over its own tree in a checkout). Absolute
 * paths: the file is generated and ignored.
 */
function siteTsconfig(root: string) {
  const { src, tsconfig } = appSources();
  const out = join(root, ".sanoma", "app");
  const react = installed("@types/react");
  const reactDom = installed("@types/react-dom");
  return {
    extends: tsconfig,
    compilerOptions: {
      types: [],
      paths: {
        "#/routeTree.gen.ts": [join(out, "routeTree.gen.ts")],
        react: [react],
        "react/*": [`${react}/*`],
        "react-dom": [reactDom],
        "react-dom/*": [`${reactDom}/*`],
        "@tanstack/*": [`${dirname(installed("@tanstack/react-router"))}/*`],
        "@sanoma-ai/app/*": [`${src}/*.ts`],
      },
    },
    include: ["../../sites", "./routeTree.gen.ts", "../api.ts", "../content.ts", join(src, "env.d.ts")],
  };
}

/** Where a bare import from `from` finds the package `name`: its own node_modules, or (pnpm) beside it. */
function moduleDir(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const found = join(dir, "node_modules", name);
    if (existsSync(found)) return found;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Where the app package finds `name`. */
function installed(name: string): string {
  const found = moduleDir(name, pkgDir);
  if (found === undefined) throw new Error(`${name} is not installed beside @sanoma-ai/app (${pkgDir})`);
  return found;
}

const defaultRuntimeFrom = join(pkgDir, "package.json");

const inside = (file: string, dir: string) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** A company's own file (a module id's path): in the repo, not in a dependency. */
const companyFile = (id: string, repo: string) => {
  const file = id.split("?")[0]!;
  return inside(file, repo) && !file.includes(`${sep}node_modules${sep}`);
};

export interface AppViteOptions {
  /** A company repo: build it, the app's routes and its sites, as one Start build. Without one, the package's own build. */
  repo?: string;
  /**
   * A file the server bundle's runtime imports resolve from: the launcher's own `package.json`, so
   * the worker and the app share one copy. Defaults to this package's `package.json`.
   */
  runtimeFrom?: string;
}

/** The Vite config of the app's build: the package's own, or with `repo` a company repo's with its sites. */
export function appViteConfig(options: AppViteOptions = {}): InlineConfig {
  return options.repo === undefined ? packageConfig() : repoConfig(realpathSync(options.repo), options.runtimeFrom);
}

const tailwindcss = async () => (await import("@tailwindcss/vite")).default();
const react = async () => (await import("@vitejs/plugin-react")).default();
const tanstackStart = async (
  options: Parameters<typeof import("@tanstack/react-start/plugin/vite").tanstackStart>[0],
) => (await import("@tanstack/react-start/plugin/vite")).tanstackStart(options);

/** The package's own build, from its directory: `dist/client` and `dist/server`, with no sites. */
function packageConfig(): InlineConfig {
  return {
    plugins: [
      // Merge tables fitted to the classes in src (see src/lib/utils.ts), rewritten when they change.
      import("cn/vite").then(({ cn }) =>
        cn({ content: ["src/**/*.tsx"], css: "src/style.css", out: "src/lib/cn-tables.ts" }),
      ),
      tailwindcss(),
      contentPlugin(),
      tanstackStart({ importProtection: { behavior: "error", client: { specifiers: [CLIENT_DENIED] } } }),
      react(),
    ],
    resolve: {
      alias: [
        // Every `cn` is the one bound to those tables, and cva's clsx is cn's (cn/engine's, which
        // joins arrays and objects as clsx does; cn/lite's joins only strings).
        { find: /^cn$/, replacement: "#/lib/utils.ts" },
        { find: /^clsx$/, replacement: "cn/engine" },
      ],
    },
    environments: {
      ssr: { resolve: { external: RUNTIME } },
    },
    server: { port: 3000 },
  };
}

/**
 * A company repo's build: the repo is Vite's root, the app's `src` (real path) Start's source
 * directory, the route tree the app's routes with `sites/` mounted at `/sites`, all of it written
 * under `.sanoma/app`. A site resolves React, TanStack and the app as the app does.
 */
function repoConfig(repo: string, runtimeFrom = defaultRuntimeFrom): InlineConfig {
  const { src } = appSources();
  const out = join(repo, ".sanoma", "app");
  const routeTree = join(out, "routeTree.gen.ts");
  const sites = join(repo, "sites");
  // Start joins srcDirectory to the root for its entries, so it must be relative.
  const srcDirectory = relative(repo, src);
  const fromApp = createRequire(join(src, "router.tsx"));
  const tailwind = installed("tailwindcss");
  return {
    configFile: false,
    root: repo,
    publicDir: false,
    cacheDir: join(out, "vite"),
    plugins: [
      {
        // The app's router imports its tree as "#/routeTree.gen.ts": the one in .sanoma/app.
        name: "sanoma:route-tree",
        enforce: "pre",
        resolveId(source, importer) {
          if (importer && source === "#/routeTree.gen.ts" && dirname(importer.split("?")[0]!) === src) {
            return routeTree;
          }
        },
      },
      sharedDeps(repo, src),
      runtimeExternal(runtimeFrom),
      contentPlugin(repo),
      tailwindcss(),
      tanstackStart({
        srcDirectory,
        router: {
          generatedRouteTree: routeTree,
          // The generator's temporary files, otherwise under `.tanstack/tmp` in the process's cwd.
          tmpDir: join(out, "tmp"),
          // The app's routes at the root, and the sites' listing at /sites. The app's __root.tsx
          // is the tree's root, not a route of the "." mount.
          virtualRouteConfig: {
            type: "root",
            file: "__root.tsx",
            children: [
              { type: "physical", directory: ".", pathPrefix: "" },
              ...(existsSync(join(sites, "__virtual.ts"))
                ? [{ type: "physical" as const, directory: sites, pathPrefix: "/sites" }]
                : []),
            ],
          },
          routeFileIgnorePattern: "^__root\\.tsx$",
        },
        importProtection: {
          behavior: "error",
          // The app's source (relative to the root when it is installed in the repo) and the sites.
          include: [`${src}/**`, `${srcDirectory}/**`, "sites/**"],
          // The defaults exclude node_modules, where the app's own source is in a company's install.
          // A site reaches the runtime most easily through `sanoma`, and Node's startApp through the app's root.
          client: { specifiers: [CLIENT_DENIED, /^(sanoma|@sanoma-ai\/app)$/], excludeFiles: [] },
          server: { excludeFiles: [] },
        },
      }),
      react(),
    ],
    resolve: {
      alias: [
        // As the package's own build, without its cn tables plugin (it would rewrite them in the
        // app's install): the tables it ships are used.
        { find: /^cn$/, replacement: join(src, "lib", "utils.ts") },
        { find: /^clsx$/, replacement: fromApp.resolve("cn/engine") },
        // A site's own stylesheet imports Tailwind from the app's install, as the app's does: the
        // company installs only sanoma. Tailwind resolves a CSS import through Vite's aliases,
        // never its plugins (so not sanoma:shared-deps).
        { find: /^tailwindcss$/, replacement: join(tailwind, "index.css") },
        { find: /^tailwindcss\/(index|theme|preflight|utilities)(\.css)?$/, replacement: join(tailwind, "$1.css") },
      ],
    },
  };
}

const CONTENT = "virtual:sanoma/content";

/** The content as `virtual:sanoma/content`'s text, each problem given to `warn`. */
function contentModule(read: ReturnType<typeof readContent>, warn: (line: string) => void): string {
  for (const problem of read.problems) warn(problemLine(problem));
  return `export default ${JSON.stringify(read.kinds)};`;
}

/**
 * `virtual:sanoma/content`, which a site's `content` imports: the repo's content (`readContent`) as
 * JSON, drafts only on the dev server; without a repo (the package's own build), none. A problem
 * in a file is a warning, never a failed build: `sanoma check` reports it. On the dev server, a
 * file added, changed or removed under `content/` writes `.sanoma/content.ts` again and reloads
 * the module, so an open page shows it with no restart.
 */
function contentPlugin(repo?: string): Plugin {
  const id = `\0${CONTENT}`;
  let drafts = false;
  // The module's text, read once for every environment, and again on a change in dev.
  let text: string | undefined;
  return {
    name: "sanoma:content",
    configResolved(config) {
      drafts = config.command === "serve";
    },
    resolveId: (source) => (source === CONTENT ? id : undefined),
    load(loaded) {
      if (loaded !== id) return;
      if (repo === undefined) return "export default {};";
      text ??= contentModule(readContent(repo, { drafts }), (line) => this.warn(line));
      return text;
    },
    configureServer(server) {
      if (repo === undefined) return;
      const dir = join(repo, "content") + sep;
      server.watcher.on("all", (event, file) => {
        // A folder (a kind), or a Markdown file: not an editor's swap file, nor an image beside a post.
        if (!file.startsWith(dir) || !(event.endsWith("Dir") || file.endsWith(".md"))) return;
        // One read for the types and the module: the dev server's has the drafts too.
        text = contentModule(writeContentTypes(repo), (line) => server.config.logger.warn(line));
        reloadFile(server, id);
      });
    },
  };
}

/** Reloads the modules of `file` (a path, or a virtual module's id) in each of the dev server's environments. */
function reloadFile(server: ViteDevServer, file: string): void {
  for (const env of Object.values(server.environments)) {
    for (const mod of env.moduleGraph.getModulesByFile(file) ?? []) void env.reloadModule(mod);
  }
}

/** A company file's (not the app's, nor a dependency's) import of React, TanStack or the app resolves as the app's own source does. */
function sharedDeps(repo: string, src: string): Plugin {
  const router = join(src, "router.tsx");
  return {
    name: "sanoma:shared-deps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !SHARED.test(source) || !companyFile(importer, repo)) return;
      return this.resolve(source, router, { ...options, skipSelf: true });
    },
  };
}

/**
 * The server bundle holds everything but the runtime, which it imports by absolute URL from
 * `runtimeFrom`'s resolution (pg and DBOS through `@sanoma-ai/workflows`'), so it needs nothing
 * from the company's install. Build only: dev's server resolves as Node does.
 */
function runtimeExternal(runtimeFrom: string): Plugin {
  return {
    name: "sanoma:runtime-external",
    apply: "build",
    enforce: "pre",
    config: () => ({ environments: { ssr: { resolve: { noExternal: true } } } }),
    applyToEnvironment: (environment) => environment.name === "ssr",
    async resolveId(source, _importer, options) {
      if (!isRuntime(source)) return;
      const opts = { ...options, skipSelf: true };
      let resolved = await this.resolve(source, runtimeFrom, opts);
      if (!resolved) {
        const workflows = await this.resolve("@sanoma-ai/workflows", runtimeFrom, opts);
        if (workflows) resolved = await this.resolve(source, workflows.id, opts);
      }
      if (!resolved) return this.error(`${source} does not resolve from ${runtimeFrom} or its @sanoma-ai/workflows`);
      return { id: pathToFileURL(resolved.id).href, external: "absolute" };
    },
  };
}

/** What `startApp` serves a company repo's app from in dev: Vite's dev server over the app's source and the sites. */
export interface AppDevServer {
  /** Vite's own answers (modules, the HMR client, files); `next` for the rest, the pages and server functions. */
  middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  /** Start's server entry, imported for each request: the module runner drops what a change touched. */
  serverEntry(): Promise<ServerEntry>;
  close(): Promise<void>;
}

/**
 * Vite's dev server for a company repo's app with its sites, in middleware mode, for `startApp`
 * to put behind its own login: the build's config (`appViteConfig`, so the route generator's
 * options are the build's and `sanoma check` beside it never rewrites the tree) with the
 * dev-only plugins (`devPlugins`), and hot updates over `http`'s upgrade. Writes the sites'
 * generated files first. A new site folder is live once its first route file is written.
 * `onFileChange` is called with each file Vite's watcher sees added, changed or removed, for the
 * launcher to decide what it means (`.sanoma/api.ts` is written from the config's files).
 */
export async function appDevServer(
  repo: string,
  http: Server,
  onFileChange?: (file: string) => void,
): Promise<AppDevServer> {
  const root = realpathSync(repo);
  writeSiteFiles(root);
  const { src } = appSources();
  const vite = await import("vite");
  const base = appViteConfig({ repo: root });
  const server = await vite.createServer({
    ...base,
    appType: "custom",
    clearScreen: false,
    plugins: [...(base.plugins ?? []), ...devPlugins(root, src, onFileChange)],
    server: {
      middlewareMode: true,
      hmr: { server: http },
      // The repo's workspace and the app's (its install, or the checkout it is linked from), where
      // its static files (fonts) are; Vite's default is the repo's alone.
      fs: { allow: [vite.searchForWorkspaceRoot(root), vite.searchForWorkspaceRoot(src)] },
    },
    // The runtime as Node loads it, the copy startApp's context holds, wherever it is installed
    // (Vite would run a linked checkout's copy itself). Vite leaves a dependency's `.js` to Node,
    // never its `.ts`: `sanoma/site.js` re-exports the app's `src/site.ts`, whose types Node
    // refuses to strip under node_modules, so from an npm install every page would fail (a linked
    // checkout hides it). `sanoma` is compiled, as the build compiles everything.
    environments: { ssr: { resolve: { external: RUNTIME, noExternal: ["sanoma"] } } },
    optimizeDeps: {
      // Shipped as source, compiled with the pages.
      exclude: ["sanoma", "@sanoma-ai/app"],
      // Every page, so the first visit finds the dependencies optimized, not a reload to do it.
      entries: [`${src}/routes/**/*.tsx`, "sites/**/*.tsx"],
    },
  });
  const ssr = server.environments.ssr;
  if (!ssr || !vite.isRunnableDevEnvironment(ssr)) {
    await server.close();
    throw new Error("Vite's ssr environment does not run modules in this process");
  }
  return {
    middlewares: (req, res, next) => server.middlewares(req, res, next),
    serverEntry: async () =>
      ((await ssr.runner.import("virtual:tanstack-start-server-entry")) as { default: ServerEntry }).default,
    close: () => server.close(),
  };
}

/**
 * The dev server's additions to the build's plugins (spike S3, E16 in the sites investigation).
 * The app and its React, TanStack and Tailwind are installed beside `sanoma`, not in the repo, and
 * a site must reach the app's copies, in the browser and on the server, as the build's
 * `sanoma:shared-deps` makes it.
 */
function devPlugins(repo: string, src: string, onFileChange?: (file: string) => void): Plugin[] {
  const sitesDir = join(repo, "sites") + sep;
  const css = join(src, "style.css");
  // A file in the app's source whose id, with the specifier in its query, stands in for a
  // company file's shared import on the server: the module runner resolves it from the app.
  const proxy = `${join(src, "dev-imports.ts")}?sanoma-shared=`;
  // How Vite's nested include reaches the app from the repo: through sanoma, which a company
  // installs, or directly.
  const viaApp = moduleDir("sanoma", repo) ? "sanoma > @sanoma-ai/app" : "@sanoma-ai/app";
  return [
    {
      // Each file the watcher sees change, for the launcher (`onFileChange`).
      name: "sanoma:dev-file-change",
      apply: "serve",
      configureServer(server) {
        if (!onFileChange) return;
        for (const event of ["add", "change", "unlink"] as const) server.watcher.on(event, onFileChange);
      },
    },
    {
      // The root's dedupe resolves from the repo, where pnpm installs no React.
      name: "sanoma:dev-server-dedupe",
      apply: "serve",
      configResolved(config) {
        for (const env of Object.values(config.environments)) {
          if (env.consumer === "server") env.resolve.dedupe = [];
        }
      },
    },
    {
      // The browser's pre-bundled dependencies are named from the root, where pnpm installs none of
      // them: name them through sanoma and the app (Vite's nested form), else CJS React is served
      // raw and the page does not hydrate.
      name: "sanoma:dev-include-via-app",
      apply: "serve",
      configResolved(config) {
        for (const env of Object.values(config.environments)) {
          if (env.consumer !== "client") continue;
          env.optimizeDeps.include = (env.optimizeDeps.include ?? []).map((id) =>
            SHARED.test(id) ? `${viaApp} > ${id}` : id,
          );
        }
      },
    },
    {
      // Tailwind's dev stylesheets watch the files they last scanned, so a class in a file added
      // under sites/ would not show until a restart: on an add or removal there, rebuild the
      // app's stylesheet and every site's own.
      name: "sanoma:dev-sites-css",
      apply: "serve",
      configureServer(server) {
        const refresh = (file: string) => {
          if (!file.startsWith(sitesDir)) return;
          for (const env of Object.values(server.environments)) {
            for (const [id, mod] of env.moduleGraph.idToModuleMap) {
              // The stylesheet itself, not a `?url` import of it, whose importer would update for nothing.
              const sheet = /\.css(\?(?!url\b)|$)/.test(id) && (mod.file === css || id.startsWith(sitesDir));
              if (sheet) void env.reloadModule(mod);
            }
          }
        };
        server.watcher.on("add", refresh);
        server.watcher.on("unlink", refresh);
      },
    },
    {
      name: "sanoma:dev-shared-proxy",
      apply: "serve",
      enforce: "pre",
      resolveId: (source) => (source.startsWith(proxy) ? source : undefined),
      load(id) {
        if (!id.startsWith(proxy)) return;
        const spec = JSON.stringify(decodeURIComponent(id.slice(proxy.length)));
        // React is CommonJS: its default export is named too.
        const cjs = /^"react(-dom)?(\/|")/.test(spec);
        return `export * from ${spec};${cjs ? ` export { default } from ${spec};` : ""}`;
      },
    },
    {
      // On the server, a company file's import of React, TanStack or the app goes through the proxy.
      name: "sanoma:dev-shared-imports",
      apply: "serve",
      enforce: "post",
      applyToEnvironment: (env) => env.name === "ssr",
      transform(code, id) {
        if (!companyFile(id, repo) || !/\.[jt]sx?$/.test(id.split("?")[0]!)) return;
        return code.replace(
          // A static import or re-export, from the start of its statement: never a string's text.
          /^(\s*(?:import\s*|(?:import|export)\b[^"']*?\bfrom\s*))(["'])([^"']+)\2/gm,
          (match, before: string, quote: string, spec: string) =>
            SHARED.test(spec) ? `${before}${quote}${proxy}${encodeURIComponent(spec)}${quote}` : match,
        );
      },
    },
  ];
}

/**
 * The build's key: the app's version and source directory, every file under `sites/` and
 * `content/` (dotfiles and dot-folders aside), and where the runtime the server bundle imports by URL is installed (a real path names
 * its version under pnpm), so an upgrade of the runtime is a new build.
 */
function buildKey(repo: string, runtimeFrom: string): string {
  const { src } = appSources();
  const hash = createHash("sha256");
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
  hash.update(`${version}\0${src}\0`);
  const workflows = moduleDir("@sanoma-ai/workflows", dirname(runtimeFrom));
  for (const name of RUNTIME) {
    const dir = moduleDir(name, dirname(runtimeFrom)) ?? (workflows && moduleDir(name, realpathSync(workflows)));
    hash.update(`${name}=${dir === undefined ? "" : realpathSync(dir)}\0`);
  }
  const files = ["sites", "content"]
    .flatMap((dir) =>
      existsSync(join(repo, dir)) ? readdirSync(join(repo, dir), { recursive: true, withFileTypes: true }) : [],
    )
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repo, join(entry.parentPath, entry.name)))
    // Dotfiles and dot-folders aside (an editor's `.obsidian/`).
    .filter((path) => !path.split(sep).some((part) => part.startsWith(".")))
    .toSorted();
  for (const path of files)
    hash
      .update(`${path}\0`)
      .update(readFileSync(join(repo, path)))
      .update("\0");
  return hash.digest("hex").slice(0, 16);
}

export interface BuildAppOptions {
  /** Receives what the build has to say: a refused site folder, Vite's warnings and errors. */
  log?: (line: string) => void;
  /** See `AppViteOptions.runtimeFrom`. */
  runtimeFrom?: string;
}

/**
 * Builds a company repo's app with its sites into `.sanoma/app/build/<key>` (`client/` and
 * `server/server.js`, for `startApp`'s `distDir`), after writing the sites' generated files. A
 * build with the same key is reused (`built: false`), its route tree put back in `.sanoma/app` for
 * the sites' tsc; a new one is built beside it and moved into place, so a directory a running app
 * serves is never overwritten.
 */
export async function buildApp(
  repo: string,
  options: BuildAppOptions = {},
): Promise<{ distDir: string; built: boolean }> {
  const root = realpathSync(repo);
  const { log } = options;
  writeSiteFiles(root);
  for (const name of sitesOf(root).refused) {
    log?.(`sites/${name} is not mounted: a site's folder name is a URL segment (lowercase letters, digits and dashes)`);
  }
  const runtimeFrom = options.runtimeFrom ?? defaultRuntimeFrom;
  const distDir = join(root, ".sanoma", "app", "build", buildKey(root, runtimeFrom));
  const routeTree = join(root, ".sanoma", "app", "routeTree.gen.ts");
  const reused = () => {
    const saved = join(distDir, "routeTree.gen.ts");
    if (existsSync(saved)) writeChanged(routeTree, readFileSync(saved, "utf8"));
    return { distDir, built: false };
  };
  if (existsSync(distDir)) return reused();
  const outDir = `${distDir}.${process.pid}.tmp`;
  const vite = await import("vite");
  const logger = vite.createLogger("warn", { allowClearScreen: false });
  const customLogger: Logger | undefined = log && {
    ...logger,
    warn: (msg) => log(msg),
    warnOnce: (msg) => log(msg),
    error: (msg) => log(msg),
  };
  try {
    const builder = await vite.createBuilder({
      ...appViteConfig({ repo: root, runtimeFrom }),
      build: { outDir, emptyOutDir: true },
      logLevel: "warn",
      customLogger,
    });
    await builder.buildApp();
    if (!existsSync(join(outDir, "server", "server.js"))) {
      throw new Error(
        `The app's server entry was not built as server/server.js: is ${root}/package.json "type": "module"?`,
      );
    }
    copyFileSync(routeTree, join(outDir, "routeTree.gen.ts"));
    renameSync(outDir, distDir);
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    // Another build of the same key finished first: use it.
    if (existsSync(distDir)) return reused();
    throw conflictOf(root, err) ?? err;
  }
  return { distDir, built: true };
}

/** The route generator's refusal of two pages with one path, said plainly: the path and the files, from the repo. */
function conflictOf(root: string, err: unknown): Error | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const found =
    /Conflicting configuration paths were found for the following routes: ([^\n]*)[\s\S]*?Conflicting files:[^\n]*\n((?:[ \t]+\S[^\n]*\n?)*)/.exec(
      message,
    );
  if (!found) return undefined;
  const paths = new Set([...found[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const files = found[2]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("at "))
    .map((file) => relative(root, file));
  return new Error(`More than one page claims ${[...paths].join(", ")}: ${files.join(", ")}`, { cause: err });
}
