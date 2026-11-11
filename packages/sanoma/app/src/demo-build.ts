// A demo's build, Node only (`buildDemo`, `sanoma demo --out <dir>`): a company repo's sites built
// as static files that run in any page, their workflows in the browser over the connectors' fakes
// (`sanoma/workflows/page`), seeded from the world (`scenarios/world.feature`), so a marketing page
// mounts a working demo with no server and no request leaving it. `sanoma/app/demo`.
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Connector,
  declarationFiles,
  filesUnder,
  isCollection,
  isOp,
  relPath,
  resolveConfig,
  type SanomaConfig,
  VENDOR,
  type WorkflowDefinition,
} from "sanoma/workflows";
import type { Collection } from "sanoma/data";
import type { World } from "sanoma/workflows/scenario";
import type { SiteEntry } from "sanoma/workflows/describe";
import { apiNameOf, DATA_VENDOR } from "sanoma/workflows/shared";
import type { Plugin, PluginOption } from "vite";
import type { AppConfig } from "./api.ts";
import {
  appSources,
  companyFile,
  MAX_PUBLIC_FILE,
  moduleDir,
  pkgDir,
  quietLogger,
  repoConfig,
  routeTreeOf,
  specifier,
  writeSiteFiles,
} from "./build.ts";
import { companyFiles, optional, pruneUnreached, vendorInfos } from "./bundle-build.ts";
import { withoutSources } from "./snapshot.ts";

/** Where the world is, from the root (`WORLD_FILE`). */
const WORLD = "scenarios/world.feature";

/** The vendor of an operation's id, `resend.emails.send`'s `resend`. */
const vendorOf = (op: string) => op.split(".")[0]!;

/** What a demo is planned from: the config's sites (their calls), workflows, connectors with their fakes, and the world. */
export interface DemoInput<W extends Pick<WorkflowDefinition, "name" | "file" | "uses">> {
  root: string;
  /** The config's file, absolute: a workflow defined there is in no file of its own. */
  configFile: string;
  sites: readonly Pick<SiteEntry, "name" | "calls">[];
  workflows: readonly W[];
  connectors: readonly Connector<any, any>[];
  /** The vendors whose connector attaches a fake (`ResolvedConfig.fakes`). */
  fakes: ReadonlySet<string>;
  /** The collections the demo bundles, by name: those the data files under `resources/` export. */
  collections: ReadonlySet<string>;
  world?: World;
}

/** What a demo bundles: the workflows the sites call, and the connectors those, the sites and the world use. */
export interface DemoPlan<W> {
  workflows: W[];
  connectors: { connector: Connector<any, any>; package: string }[];
}

/** Refused, with every reason, one per line, each at the file it is about (from the root). */
export class DemoRefused extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`This repo cannot be a demo:\n  ${reasons.join("\n  ")}`);
    this.name = "DemoRefused";
    this.reasons = reasons;
  }
}

/**
 * The demo's plan: every workflow a site calls (by `RunForm` or `api`), each from a file of its
 * own, and every vendor those workflows, the sites' direct calls and the world's Givens use, each
 * by a connector from a package with a fake. Refuses (`DemoRefused`) a workflow defined in the
 * config, a collection a site reads from no data file, an operation of `sanoma` (the repository's and the app's, which a page has none of), a
 * vendor with no connector, no fake, or no package to import it from in the page.
 */
export function demoPlan<W extends Pick<WorkflowDefinition, "name" | "file" | "uses">>(
  input: DemoInput<W>,
): DemoPlan<W> {
  const { root, configFile, sites, workflows, connectors, fakes, collections, world } = input;
  const from = (file: string) => relPath(root, file);
  const reasons: string[] = [];
  const bundled = new Set<W>();
  /** Each vendor used, and where first. */
  const vendors = new Map<string, string>();
  const use = (op: string, where: string) => {
    if (op.startsWith("sanoma.")) reasons.push(`${where}: ${op} is the app's own, which a demo has none of`);
    else useVendor(vendorOf(op), where);
  };
  const useVendor = (vendor: string, where: string) => {
    if (vendor !== DATA_VENDOR && !vendors.has(vendor)) vendors.set(vendor, where);
  };
  for (const site of sites) {
    for (const call of site.calls) {
      const where = `${call.file}:${call.line}`;
      if (call.kind === "op") use(call.target, where);
      if (call.kind === "collection" && !collections.has(call.target))
        reasons.push(
          `${where}: reads ${call.target}, a collection no data file under resources/ exports, which a demo bundles its collections from`,
        );
      if (call.kind !== "workflow") continue;
      const wf = workflows.find((w) => w.name === call.target || apiNameOf(w.name) === call.target);
      if (!wf) reasons.push(`${where}: calls ${call.target}, which is no workflow of the config's`);
      else if (wf.name.startsWith("sanoma."))
        reasons.push(`${where}: ${wf.name} is the app's own, which a demo has none of`);
      else if (wf.file === configFile)
        reasons.push(
          `${where}: ${wf.name} is defined in ${from(configFile)}: a demo bundles a workflow from its own file, under workflows/`,
        );
      else bundled.add(wf);
    }
  }
  for (const wf of bundled) for (const op of wf.uses.filter(isOp)) use(op.id, from(wf.file));
  for (const given of world?.given ?? []) {
    if ("op" in given) use(given.op, WORLD);
    else useVendor(given.vendor, WORLD);
  }
  const planned: DemoPlan<W>["connectors"] = [];
  for (const [vendor, where] of vendors) {
    const connector = connectors.find((c) => c[VENDOR].id === vendor);
    const pkg = connector?.[VENDOR].info?.package;
    if (!connector) reasons.push(`${where}: uses ${vendor}, but the config has no connector for it`);
    else if (!fakes.has(vendor))
      reasons.push(`${where}: uses ${vendor}, whose connector attaches no fake, which a demo runs every vendor on`);
    else if (!pkg)
      reasons.push(
        `${where}: uses ${vendor}, whose connector names no package (info.package) for the page to import it from`,
      );
    else planned.push({ connector, package: pkg });
  }
  if (reasons.length) throw new DemoRefused(reasons);
  return { workflows: [...bundled], connectors: planned };
}

export interface BuildDemoOptions {
  /** The company's config, loaded from its file (`loadConfig`), with its declaration files joined. */
  config: SanomaConfig;
  /** Where the demo goes, emptied first: a site's `public/demos/<name>/`, say, which the site then serves. */
  out: string;
  /** See `BuildAppOptions.log`. */
  log?: (line: string) => void;
}

/** `description` with every path under `root` named from it; refused if a path of the machine's is left, since the page is public. */
function publicDescription(description: AppConfig, root: string): AppConfig {
  const text = JSON.stringify(description).replaceAll(JSON.stringify(`${root}${sep}`).slice(1, -1), "");
  const left = [root, homedir()]
    .filter((path) => path.length > 1)
    .find((path) => text.includes(JSON.stringify(path).slice(1, -1)));
  if (left !== undefined) throw new Error(`A demo's description would publish a path of this machine's: ${left}`);
  return JSON.parse(text) as AppConfig;
}

/** What a demo writes in its folder, each the only names a folder it is built into may hold. */
const DEMO_FILES = new Set(["mount.js", "demo.css", "index.html", "chunks", "files"]);

/**
 * The prefix of a site's stylesheet imported by its URL, which the demo bundles instead
 * (`demoPlugins`): its id ends in `.js`, so Vite's CSS plugins leave the module alone.
 */
const STYLESHEET = "\0sanoma-demo-stylesheet:";

/** The module the demo's entry imports (`virtual:sanoma/demo`, `demoModule`). */
const DEMO = "virtual:sanoma/demo";

/** The selector every rule of `demo.css` is scoped to: the element `mount` renders into. */
const SCOPE = "[data-sanoma-demo]";

/** `selector` under the demo's element: the document's own (`:root`, `html`, `body`, `:host`) is the element. */
const scopedSelector = (selector: string) => {
  if (selector.startsWith(SCOPE)) return selector;
  const host = /^:host\(([^)]*)\)/.exec(selector);
  if (host) return SCOPE + host[1] + selector.slice(host[0].length);
  const own = /^(:root|html|body|:host)(?![\w-])/.exec(selector);
  return own ? SCOPE + selector.slice(own[0].length) : `${SCOPE} ${selector}`;
};

/** A PostCSS node, as far as `scoped` reads one. */
interface CssNode {
  type: string;
  name?: string;
  parent?: CssNode;
}

/**
 * A PostCSS plugin (Vite runs PostCSS on every stylesheet, after Tailwind) scoping each rule to the
 * demo's element: not a nested rule (its parent rule is scoped) nor a keyframe.
 */
const scoped = () => ({
  postcssPlugin: "sanoma-demo-scope",
  Rule(rule: CssNode & { selectors: string[] }) {
    for (let up = rule.parent; up; up = up.parent) {
      if (up.type === "rule" || (up.type === "atrule" && /keyframes$/i.test(up.name ?? ""))) return;
    }
    // Set only when changed: PostCSS visits a changed rule again.
    const selectors = [...new Set(rule.selectors.map(scopedSelector))];
    if (selectors.length !== rule.selectors.length || selectors.some((s, i) => s !== rule.selectors[i]))
      rule.selectors = selectors;
  },
});

/** Whether `value` is a connector of `vendor`, as the page finds one among its package's exports. */
const isConnectorOf = (value: unknown, vendor: string) =>
  typeof value === "object" && value !== null && (value as Partial<Connector<any, any>>)[VENDOR]?.id === vendor;

/** A module's exports `keep` keeps, by name, the module imported from its file. */
const exportsOf = async (file: string, keep: (value: unknown) => boolean) =>
  Object.entries((await import(pathToFileURL(realpathSync(file)).href)) as Record<string, unknown>).filter(
    ([, value]) => keep(value),
  );

/** `value` as a JavaScript expression: JSON parsed, which engines read faster than an object literal. */
const json = (value: unknown) => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;

/** `virtual:sanoma/demo`'s text: imports by name of what the page runs, the world and the description as JSON. */
function demoModule(parts: {
  routeTree: string;
  workflows: { file: string; name: string }[];
  collections: { file: string; names: string[] }[];
  connectors: { package: string; name: string }[];
  world: World | undefined;
  description: unknown;
  sites: string[];
}): string {
  const collections = parts.collections.flatMap(({ names }, i) => names.map((_, j) => `d${i}_${j}`));
  return [
    'import { pageRuntime } from "sanoma/workflows/page";\n',
    ...parts.workflows.map(({ file, name }, i) => `import { ${name} as w${i} } from ${specifier(file)};\n`),
    ...parts.collections.map(
      ({ file, names }, i) =>
        `import { ${names.map((n, j) => `${n} as d${i}_${j}`).join(", ")} } from ${specifier(file)};\n`,
    ),
    ...parts.connectors.map(
      ({ package: pkg, name }, i) => `import { ${name} as c${i} } from ${JSON.stringify(pkg)};\n`,
    ),
    `export { routeTree } from ${specifier(parts.routeTree)};\n`,
    `const world = ${parts.world ? json(parts.world) : "undefined"};\n`,
    `export const runtime = () => pageRuntime({ workflows: [${parts.workflows.map((_, i) => `w${i}`).join(", ")}], `,
    `collections: [${collections.join(", ")}], `,
    `connectors: [${parts.connectors.map((_, i) => `c${i}`).join(", ")}], world });\n`,
    `export const description = ${json(parts.description)};\n`,
    `export const sites = ${JSON.stringify(parts.sites)};\n`,
  ].join("");
}

/**
 * The demo's plugins: `virtual:sanoma/demo`; `site-api.ts`, the one binding of a site's `api`, the
 * page runtime's (`demo/api.ts`); every server function's client stub one that fails in the page
 * (`demo/client-rpc.ts`); a site's stylesheet imported for its `?url` part of `demo.css`; and the
 * client environment's entry `demo/mount.tsx`, built to `mount.js` with its chunks and `demo.css`.
 */
function demoPlugins(root: string, src: string, text: string, conditions: string[], keep: string[]): PluginOption[] {
  // Vite's module ids have forward slashes, on Windows too.
  const siteApi = join(src, "site-api.ts").split(sep).join("/");
  const output = {
    entryFileNames: "mount.js",
    chunkFileNames: "chunks/[name]-[hash].js",
    assetFileNames: ({ names }: { names: readonly string[] }) =>
      names.some((name) => name.endsWith(".css")) ? "demo.css" : "files/[name]-[hash][extname]",
  };
  const bundler = { input: { index: join(src, "demo", "mount.tsx") }, preserveEntrySignatures: "exports-only", output };
  return [
    {
      name: "sanoma:demo",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (source === DEMO) return `\0${DEMO}`;
        // What the company module imports, as the company's own files do: from its root.
        if (importer === `\0${DEMO}`)
          return this.resolve(source, join(root, "package.json"), { ...options, skipSelf: true });
        if (source === "@tanstack/react-start/client-rpc") return join(src, "demo", "client-rpc.ts");
        // A site's stylesheet by its URL (`?url`): the page has no head of the site's to link it
        // from, so it is part of the demo's, and its URL none.
        if (source.endsWith(".css?url") && importer && companyFile(importer, root)) {
          const css = await this.resolve(source.slice(0, -"?url".length), importer, { skipSelf: true });
          if (css) return `${STYLESHEET}${css.id}.js`;
        }
      },
      load(id) {
        if (id === `\0${DEMO}`) return text;
        if (id === siteApi) return `export { api } from ${specifier(join(src, "demo", "api.ts"))};\n`;
        if (id.startsWith(STYLESHEET))
          return `import ${specifier(id.slice(STYLESHEET.length, -".js".length))};\nexport default "";\n`;
      },
    } satisfies Plugin,
    {
      name: "sanoma:demo-entry",
      enforce: "post",
      // The names on the top level too, where Vite reads them to make the stylesheet's URLs relative.
      config: () => ({ build: { assetsDir: "", rollupOptions: { output }, rolldownOptions: { output } } }) as never,
      configEnvironment(name) {
        if (name !== "client") return;
        return {
          resolve: { conditions },
          build: {
            rollupOptions: bundler,
            rolldownOptions: bundler,
            cssCodeSplit: false,
            modulePreload: { polyfill: false },
            copyPublicDir: false,
          },
        } as never;
      },
    } satisfies Plugin,
    {
      // What the page loads, by static and dynamic imports: refused when it holds what only a
      // server has (Node's modules, as Vite's browser stub for each, DBOS, Postgres's client,
      // Drizzle); the rest left out, as a chunk only tree-shaken code imported, or a file only
      // such code named (the runtime's `new URL(…, import.meta.url)`), would only be served for nothing.
      name: "sanoma:demo-reachable",
      applyToEnvironment: (env) => env.name === "client",
      // Last: after Vite's own, which writes the stylesheet that names the fonts.
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const reached = pruneUnreached(bundle);
          const found = [...reached]
            .flatMap((name) => (bundle[name] as { moduleIds: string[] }).moduleIds)
            .flatMap((id) => {
              const only = SERVER_ONLY.exec(id);
              return only ? [only[1] || only[2] || id] : [];
            });
          if (found.length) {
            this.error(
              `A demo runs in the browser, and its page would load what only a server has: ${[...new Set(found)].join(", ")}`,
            );
          }
          const texts = Object.values(bundle).map((file) => (file.type === "chunk" ? file.code : String(file.source)));
          for (const file of Object.values(bundle)) {
            const name = file.fileName.slice(file.fileName.lastIndexOf("/") + 1);
            if (file.type === "asset" && !file.fileName.endsWith(".css") && !texts.some((code) => code.includes(name)))
              delete bundle[file.fileName];
          }
        },
      },
    } satisfies Plugin,
    vendorInfos(),
    companyFiles(root, { fromRoot: true }),
    optional(keep),
  ];
}

/** A module only a server has, by its id in a browser build: what it is, named. */
const SERVER_ONLY = /__vite-browser-external:?(.*)$|[\\/]node_modules[\\/](@dbos-inc[\\/][^\\/]+|pg|drizzle-orm)[\\/]/;

/** True when the app runs from a checkout of sanoma, whose `sanoma-source` entries are all there (an install ships some as `dist/` alone). */
const fromCheckout = () => !pkgDir.split(sep).includes("node_modules");

/** The page that shows the demo on its own: `index.html`, beside `mount.js`. */
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo</title>
    <link rel="stylesheet" href="./demo.css" />
  </head>
  <body>
    <div id="demo"></div>
    <script type="module">
      import { mount } from "./mount.js";
      mount(document.getElementById("demo"));
    </script>
  </body>
</html>
`;

/**
 * Builds the demo of a company repo's sites into `out`, emptied first (refused when it holds files
 * and no `mount.js`, so it is no demo's): `mount.js` (`mount(element, { path, exit })`, see
 * `demo/mount.tsx`), its `chunks/`, `demo.css` (scoped to the element, no preflight), the files
 * it references under `files/`, and `index.html`, which mounts it alone, every URL relative, so
 * it is served from any folder (a site's `public/demos/<name>/`). The sites call workflows from
 * their own files; their vendors are fakes; the world is checked by seeding it once, here.
 * Returns the files written, from `out`.
 */
export async function buildDemo(repo: string, { config, out, log }: BuildDemoOptions): Promise<{ files: string[] }> {
  const root = realpathSync(repo);
  const held = existsSync(out) ? readdirSync(out) : [];
  const others = held.filter((name) => !DEMO_FILES.has(name));
  if (others.length || (held.length && !held.includes("mount.js"))) {
    throw new Error(
      `${out} holds ${(others.length ? others : held).join(", ")}, and no demo's alone: a demo's folder is emptied when it is built`,
    );
  }
  const [{ describeConfig }, { loadWorld }, { pageRuntime }, vite] = await Promise.all([
    import("sanoma/workflows/describe"),
    import("sanoma/workflows/scenario"),
    import("sanoma/workflows/page"),
    import("vite"),
  ]);
  writeSiteFiles(root);
  const description = describeConfig(config);
  if (!description.sites.length) throw new DemoRefused([`${root} has no sites: a demo is of its sites/<name>/routes/`]);
  const resolved = resolveConfig(config);
  const world = await loadWorld(resolved);
  const data = await Promise.all(
    declarationFiles(root).data.map(async (file) => ({ file, found: await exportsOf(file, isCollection) })),
  );
  const collections = data.flatMap(({ found }) => found.map(([, value]) => value as Collection));
  const plan = demoPlan({
    root,
    configFile: config.file ?? join(root, "sanoma.config.ts"),
    sites: description.sites,
    workflows: config.workflows ?? [],
    connectors: config.connectors,
    fakes: new Set(resolved.fakes.keys()),
    collections: new Set(collections.map((c) => c.name)),
    world,
  });
  // The connectors as the page has them, each its package's export (the config's may be another
  // instance, with another fake); the world seeded with them once in Node, as each mount seeds it.
  const fromRoot = createRequire(join(root, "package.json"));
  const exported = await Promise.all(
    plan.connectors.map(async ({ connector, package: pkg }) => {
      const vendor = connector[VENDOR].id;
      const matches = await exportsOf(fromRoot.resolve(pkg), (value) => isConnectorOf(value, vendor));
      // The config's own export when the package has several of the vendor (one with a setup of its own).
      const found = matches.find(([, value]) => value === connector) ?? matches[0];
      if (!found) throw new DemoRefused([`${pkg}: exports no connector of ${vendor}, which a demo imports`]);
      return { package: pkg, name: found[0], connector: found[1] as Connector<any, any> };
    }),
  );
  await pageRuntime({ workflows: plan.workflows, collections, connectors: exported.map((c) => c.connector), world });

  const unexported: string[] = [];
  const workflows = await Promise.all(
    plan.workflows.map(async (wf) => {
      const name = (await exportsOf(wf.file, (value) => value === wf))[0]?.[0];
      if (name === undefined) unexported.push(`${relPath(root, wf.file)}: exports no ${wf.name}, which a demo imports`);
      return { file: wf.file, name: name ?? "" };
    }),
  );
  if (unexported.length) throw new DemoRefused(unexported);

  const sites = description.sites.map((site) => site.name);
  // What the app's `getConfig` answers (`appConfig`), of what the demo runs alone, for a start
  // form: the page is public, so never the policies, secrets, connections, resources or login.
  const vendors = new Set([DATA_VENDOR, ...plan.connectors.map(({ connector }) => connector[VENDOR].id)]);
  const shown: AppConfig = {
    appName: description.appName,
    name: description.name,
    version: description.version,
    workflows: withoutSources(description).workflows.filter((wf) => plan.workflows.some((p) => p.name === wf.name)),
    ops: description.ops.filter((op) => vendors.has(op.vendor)),
    vendors: Object.fromEntries(Object.entries(description.vendors).filter(([vendor]) => vendors.has(vendor))),
    agents: [],
    resourceTypes: [],
    collections: description.collections,
    resources: [],
    orphans: [],
    problems: [],
    apps: description.apps,
    policy: { defined: false, files: [] },
    sites: [],
    place: "live",
    content: [],
  };
  const text = demoModule({
    routeTree: routeTreeOf(root, "demo"),
    workflows,
    collections: data
      .map(({ file, found }) => ({ file, names: found.map(([name]) => name) }))
      .filter((c) => c.names.length),
    connectors: exported,
    world,
    // From the root, never the machine's paths: the page is public.
    description: publicDescription(shown, root),
    sites,
  });
  const conditions = [...(fromCheckout() ? ["sanoma-source"] : []), "browser", "module", "import", "default"];
  // An optional peer, bundled when the company installed it.
  const keep = moduleDir("@react-pdf/renderer", pkgDir) ? ["@react-pdf/renderer"] : [];

  const outDir = join(root, ".sanoma", "app", "demo", `build.${process.pid}`);
  const { src } = appSources();
  const base = repoConfig(root, { kind: "demo", plugins: demoPlugins(root, src, text, conditions, keep) });
  try {
    const builder = await vite.createBuilder({
      ...base,
      base: "./",
      // A page for anyone: React's production build, never its development JSX, which names each
      // file by its path, whatever NODE_ENV the process has.
      mode: "production",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      oxc: { jsx: { development: false } },
      css: { postcss: { plugins: [scoped()] } },
      resolve: {
        ...base.resolve,
        // A site's own `@import "tailwindcss"` without preflight; then the build's aliases.
        alias: [
          { find: /^tailwindcss$/, replacement: join(src, "demo", "tailwind.css") },
          ...(base.resolve!.alias as { find: RegExp; replacement: string }[]),
        ],
      },
      build: { outDir, emptyOutDir: true },
      logLevel: "warn",
      customLogger: quietLogger(vite, log),
    });
    // The page's alone: a demo has no server.
    await builder.build(builder.environments.client!);
    const client = join(outDir, "client");
    const files = filesUnder(client, () => true).map((file) => relative(client, file).split(sep).join("/"));
    const big = files.filter((file) => statSync(join(client, file)).size > MAX_PUBLIC_FILE);
    if (big.length) throw new Error(`A demo's file is 25 MiB at most: ${big.join(", ")}`);
    writeFileSync(join(client, "index.html"), INDEX);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(client, out, { recursive: true });
    return { files: [...files, "index.html"].toSorted() };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
