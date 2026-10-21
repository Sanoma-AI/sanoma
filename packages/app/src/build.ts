// The app's build, Node only: the package's own (`vite.config.ts`), and a company repo's with its
// sites, the app's routes plus every `sites/<name>/routes` as one TanStack Start build under
// `<repo>/.sanoma/app`. Nothing is written into the app package or under `node_modules`. Only
// Node's modules load with this file; Vite and its plugins load when a config or build needs them.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InlineConfig, Logger, Plugin } from "vite";

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

/** A site's folder name: one URL segment. */
const SITE_NAME = /^[a-z][a-z0-9-]*$/;

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
 * Writes the sites' generated files: `sites/__virtual.ts` when missing or different,
 * `sites/tsconfig.json` when missing, and `.sanoma/app/tsconfig.json` always (the route generator
 * reads `sites/tsconfig.json`, and so the file it extends, when it loads the listing).
 */
export function writeSiteFiles(repo: string): void {
  const root = realpathSync(repo);
  const sites = join(root, "sites");
  const out = join(root, ".sanoma", "app");
  mkdirSync(sites, { recursive: true });
  mkdirSync(out, { recursive: true });
  const virtual = join(sites, "__virtual.ts");
  if (!existsSync(virtual) || readFileSync(virtual, "utf8") !== SITES_VIRTUAL) writeFileSync(virtual, SITES_VIRTUAL);
  const sitesTsconfig = join(sites, "tsconfig.json");
  if (!existsSync(sitesTsconfig)) writeFileSync(sitesTsconfig, '{ "extends": "../.sanoma/app/tsconfig.json" }\n');
  writeFileSync(join(out, "tsconfig.json"), `${JSON.stringify(siteTsconfig(root), null, 2)}\n`);
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
    include: ["../../sites", "./routeTree.gen.ts", "../api.ts", join(src, "env.d.ts")],
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
      tailwindcss(),
      tanstackStart({
        srcDirectory,
        router: {
          generatedRouteTree: routeTree,
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
      ],
    },
  };
}

/** A company file's (not the app's, nor a dependency's) import of React, TanStack or the app resolves as the app's own source does. */
function sharedDeps(repo: string, src: string): Plugin {
  const router = join(src, "router.tsx");
  return {
    name: "sanoma:shared-deps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !SHARED.test(source)) return;
      const file = importer.split("?")[0]!;
      if (!inside(file, repo) || file.includes(`${sep}node_modules${sep}`)) return;
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

/**
 * The build's key: the app's version and source directory, every file under `sites/` (dotfiles
 * aside), and where the runtime the server bundle imports by URL is installed (a real path names
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
  const sites = join(repo, "sites");
  const files = existsSync(sites) ? readdirSync(sites, { recursive: true, withFileTypes: true }) : [];
  for (const file of files
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted()) {
    hash
      .update(`${relative(repo, file)}\0`)
      .update(readFileSync(file))
      .update("\0");
  }
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
 * build with the same key is reused (`built: false`); a new one is built beside it and moved into
 * place, so a directory a running app serves is never overwritten.
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
  if (existsSync(distDir)) return { distDir, built: false };
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
    renameSync(outDir, distDir);
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    // Another build of the same key finished first: use it.
    if (existsSync(distDir)) return { distDir, built: false };
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
