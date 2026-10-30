import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { childrenOf, keyName, type LintProblem, type Node, readSource, type SourceFile } from "./ast.ts";
import { type CedarPolicySource, visitorPermits } from "./cedar.ts";
import type { ConfigDescription, SiteCall, SiteEntry, SitePage } from "./description.ts";
import { stringValue, unwrap } from "./outline.ts";
import { exportsOf, loadModules } from "./load.ts";
import { APPS_DIR, appFolders, filesUnder, isDirectory, relPath, SITE_ENTRIES } from "./paths.ts";
import type { ResourceProblem } from "./resources.ts";
import { START } from "./schema.ts";
import {
  ANONYMOUS,
  apiNameOf,
  BUILT_IN_WORKFLOWS,
  DATA_VENDOR,
  LOCALE,
  SITE_NAME,
  siteKey,
  VISITORS,
  WORKFLOW_ACTION,
} from "./shared.ts";

// What a company's sites call, read from their source with oxc and never run (their pages are
// browser code, the site's outline): the reverse index a workflow's page shows as Used by, and
// the names `sanoma check` holds to the config. A site's `site.ts` is loaded.

export type { SiteCall, SiteEntry, SitePage };

/** Where a site's code is: its pages and its components. */
const SITE_DIRS = ["routes", "components"];
const KIND_NAMES = { workflow: "workflow", collection: "collection", op: "operation" } as const;
/** What a route's loader and head name its path's parameters by. */
const PARAMS: ReadonlySet<string> = new Set(["params"]);
/** What makes a route from its id, whose first argument is the id. */
const ROUTE_MAKERS: ReadonlySet<string> = new Set(["createFileRoute", "createLazyFileRoute"]);

/**
 * The sites under `root` (`sitesUnder`): each folder of `sites/`, then of each app's
 * `apps/<app>/sites/`, with a `routes/` whose name is a URL segment, by key (as
 * `@sanoma-ai/app/build`'s `sitesOf` mounts them). Reads `routes/**` and
 * `components/**` (`.ts` and `.tsx`, less tests and declarations) of each with oxc, never running
 * them: each page (`SitePage`, from a route's id), each `<RunForm workflow="…" />` and each use of `api`, both imported from `sanoma/site`,
 * called or passed on (`queryFn: api.data.leads.list`):
 * `api.<name>` and `api.<name>.<method>` are a workflow, `api.data.<collection>.<op>` (an app's
 * `api.data.<app>.<collection>.<op>`) a collection,
 * and `api.<vendor>.<resource>.<op>` an operation. A name that is not written out (a variable, a
 * template with holes, a computed member) is skipped, as is a use through a namespace import or a
 * destructured `api`. A call to what `description` does not have, or to an operation a page may
 * not call directly, is a problem. So is a `login` in `site.ts` that does not name one of
 * `connectors.logins` (the vendors whose connector has a login half) on a public site. Given the
 * company's `policies` (undefined while they have problems, which refuse every call), so is a
 * public site's start or direct call that no company `permit` could let a visitor make
 * (`visitorPermits`): one for `anonymous`, or on a site with a login, one for `anonymous` or the
 * `visitors`, whatever its conditions. Whatever the policies, so is a public site's call of a
 * built-in workflow, and its read of a workflow's runs but `.result`, which `callApi` refuses a visitor.
 */
export function readSites(
  root: string | undefined,
  description: Pick<ConfigDescription, "workflows" | "collections" | "ops">,
  connectors: SiteConnectors,
  policies?: readonly CedarPolicySource[],
): SiteEntry[] {
  if (root === undefined) return [];
  const workflows = new Set(description.workflows.map((wf) => wf.name));
  const collections = new Set(description.collections.map((c) => c.name));
  // `api.data.<app>.<collection>` passed on as a value reads as a call of `<app>`'s method: it is none.
  const isAppCollection = ({ kind, name, method }: Written) =>
    kind === "collection" && collections.has(`${name}.${method}`);
  const ops = new Map(description.ops.map((op) => [op.id, op]));
  // A workflow's api name to its name: two of one api name are a problem on the workflows.
  const byApiName = new Map(description.workflows.map((wf) => [apiNameOf(wf.name), wf.name]));
  const permits = policies && visitorPermits(policies);

  /**
   * Why a visitor's `call`, which exists, is certainly refused on a public site that has `login`:
   * as `callApi` refuses it whatever the policy says, or as no permit could allow it.
   */
  const refused = (call: SiteCall, login: string | undefined): string | undefined => {
    const why = `a visitor's call to ${KIND_NAMES[call.kind]} "${call.target}" is refused`;
    let action: string;
    let group: string;
    if (call.kind === "workflow") {
      if (BUILT_IN_WORKFLOWS.has(call.target)) return `${why}: a visitor may not start the runtime's own workflows`;
      if (call.method === "result") return undefined;
      if (call.method !== undefined && call.method !== "start") {
        return `${why}: a visitor reads only the result of a run it started`;
      }
      [action, group] = [`${WORKFLOW_ACTION}${call.target}`, START];
    } else {
      action = call.kind === "op" ? call.target : `${DATA_VENDOR}.${call.target}.${call.method}`;
      const op = ops.get(action);
      if (!op) return undefined;
      group = `effect:${op.effect}`;
    }
    if (!permits) return undefined;
    const [scopes, principal] =
      login === undefined
        ? [[ANONYMOUS], `== Sanoma::Principal::"${ANONYMOUS}"`]
        : [[ANONYMOUS, VISITORS], `in Sanoma::Group::"${VISITORS}"`];
    if (permits(new Set(scopes), action, group)) return undefined;
    return (
      `${why}: no permit in policies/ names ${scopes.join(" or ")} for ${action}. ` +
      `Add: permit (principal ${principal}, action == Sanoma::Action::"${action}", resource);`
    );
  };

  /** A call as written, resolved as the app's `callApi` resolves it, with why it would fail. */
  const resolve = ({ kind, name, via, ...at }: Written): { call: SiteCall; problem?: string } => {
    const target = kind === "workflow" && via === "api" ? (byApiName.get(name) ?? name) : name;
    const found =
      kind === "workflow"
        ? via === "api"
          ? byApiName.has(name)
          : workflows.has(name)
        : kind === "collection"
          ? collections.has(name)
          : ops.has(name);
    const problem = !found
      ? `calls ${KIND_NAMES[kind]} "${target}", which does not exist`
      : kind === "op" && !ops.get(name)!.direct
        ? `calls operation "${target}", which a page may not call directly: start a workflow that calls it`
        : undefined;
    return { call: { kind, target, via, ...at }, ...(problem && { problem }) };
  };

  return sitesUnder(root).map(({ name, app, dir }) => {
    const read = readSiteFiles(root, dir);
    const resolved = read.flatMap(({ uses }) => uses.filter((use) => !isAppCollection(use)).map(resolve));
    const pages = pagesOf(read);
    const { problems: optionProblems, ...options } = siteDefinitionOf(root, dir, connectors);
    const calls = resolved.map((r) => r.call);
    const problems = [
      ...resolved.flatMap(({ call, problem }) => {
        const message = problem ?? (options.public ? refused(call, options.login) : undefined);
        return message === undefined ? [] : [{ file: call.file, line: call.line, column: call.column, message }];
      }),
      ...optionProblems,
    ];
    const sorted = [...pages.keys()].toSorted().map((path) => pages.get(path)!);
    // A page's file it warns of, unless another of its files (a lazy one, its layout) gives its kind.
    const warnings = options.public
      ? read.flatMap(({ route, warning }) => (warning && !pages.get(route!.path)?.content ? [warning] : []))
      : [];
    return { name, ...(app && { app }), ...options, pages: sorted, calls, problems, warnings };
  });
}

/**
 * What a route made by `createFileRoute(id)({ … })` says of the sitemap, `staticData`'s `sitemap`
 * written out (a lazy route's options carry no `staticData`), and how much it is its page's own:
 * an index (2) over a route at its path (1). A pathless or group layout's says nothing.
 */
type Says = { listed: boolean; rank: number };

/** A route file's page, with what its route says of the sitemap. */
type FileRoute = Omit<SitePage, "sitemap"> & { says?: Says };

/** A site's pages, by path, from its files: a layout's and its index's (one path) merged, the most its own route that says deciding `sitemap`. */
function pagesOf(read: readonly { route?: FileRoute }[]): Map<string, SitePage> {
  const pages = new Map<string, SitePage>();
  const own = new Map<string, Says>();
  for (const { route } of read) {
    if (!route) continue;
    const { says, ...page } = route;
    pages.set(page.path, { ...pages.get(page.path), ...page });
    if (says && says.rank > (own.get(page.path)?.rank ?? 0)) own.set(page.path, says);
  }
  for (const [path, { listed }] of own) if (!listed) pages.get(path)!.sitemap = false;
  return pages;
}

/** Each file of the site in `dir` (relative to `root`), as `readSiteFile` reads it, by path. */
const readSiteFiles = (root: string, dir: string) =>
  SITE_DIRS.flatMap((sub) => filesUnder(join(root, dir, sub), isSource))
    .toSorted()
    .flatMap((path) => {
      const file = readSource(path);
      return typeof file === "string" ? [] : [readSiteFile(file, relPath(root, path))];
    });

/**
 * Each site's pages under `root` whose entries are a content kind's (`SitePage.content`), path to
 * kind: what the app's build gives its router (`virtual:sanoma/locales`), so a page lists only the
 * languages its entry is in. Read as `readSites` reads them, never run.
 */
export function siteContentPages(root: string): Record<string, string> {
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ dir }) =>
      [...pagesOf(readSiteFiles(root, dir)).values()].flatMap(({ path, content }) =>
        content ? [[path, content]] : [],
      ),
    ),
  );
}

/**
 * Each site's languages (`defineSite({ locales })`, the first its default) under `root`, by name,
 * for the sites whose `site.ts` gives them without a problem there: what the app's build gives
 * its router (`virtual:sanoma/locales`). Loaded as `readSites` loads them.
 */
export function siteLocales(root: string): Record<string, string[]> {
  const none = new Set<string>();
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ name, dir }) => {
      const { locales } = siteDefinitionOf(root, dir, { vendors: none, logins: none });
      return locales ? [[name, locales]] : [];
    }),
  );
}

/**
 * Each site's icon (`defineSite({ icon })`, a Lucide icon's name as written) under `root`, by name,
 * for the sites whose `site.ts` gives one: the icons the app's build bundles (`virtual:sanoma/icons`).
 * Loaded as `readSites` loads it.
 */
export function siteIcons(root: string): Record<string, string> {
  const none = new Set<string>();
  return Object.fromEntries(
    sitesUnder(root).flatMap(({ name, dir }) => {
      const { icon } = siteDefinitionOf(root, dir, { vendors: none, logins: none });
      return icon === undefined ? [] : [[name, icon]];
    }),
  );
}

/**
 * The sites under `root`, by key (`siteKey`): each folder of `sites/` with a `routes/` whose name
 * is a URL segment, then each app's `apps/<app>/sites/`, with its folder relative to `root`.
 */
export const sitesUnder = (root: string): { name: string; app?: string; dir: string }[] => [
  ...siteNames(join(root, "sites")).map((name) => ({ name, dir: `sites/${name}` })),
  ...appFolders(root).flatMap((folder) => {
    const app = basename(folder);
    return siteNames(join(folder, "sites")).map((name) => ({
      name: siteKey(app, name),
      app,
      dir: `${APPS_DIR}/${app}/sites/${name}`,
    }));
  }),
];

/** The sites in `dir`: each folder with a `routes/` whose name is a URL segment, sorted. */
const siteNames = (dir: string): string[] =>
  isDirectory(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SITE_NAME.test(d.name) && existsSync(join(dir, d.name, "routes")))
        .map((d) => d.name)
        .toSorted()
    : [];

/** A use of `api` or a `RunForm`, as written: the name it gives, before it is resolved. */
type Written = Omit<SiteCall, "target"> & { name: string };

/**
 * What one file holds: its uses, in its order, and the page it is, from its route's id, with the
 * content kind whose entry its one parameter names (`SitePage.content`) and whether its route's
 * options keep it out of the sitemap (`SitePage.sitemap`). A file under `routes/` is read whole;
 * any other only when it imports `api` or `RunForm`.
 */
function readSiteFile(
  { program, at }: SourceFile,
  file: string,
): { uses: Written[]; route?: FileRoute; warning?: LintProblem & { file: string } } {
  const api = importedAs(program, SITE_ENTRIES, "api");
  const runForm = importedAs(program, SITE_ENTRIES, "RunForm");
  const content = importedAs(program, SITE_ENTRIES, "content");
  if (!api.size && !runForm.size && !file.includes("/routes/")) return { uses: [] };
  const found: Omit<Written, "page">[] = [];
  /** Each `content.<kind>.get(arg)`: its kind, its argument and where it is. */
  const gets: { kind: string; arg: Node; start: number }[] = [];
  let page: string | undefined;
  let says: Says | undefined;
  const visit = (node: Node) => {
    if (!node) return;
    if (node.type === "MemberExpression") {
      const named = apiPath(node, api);
      // The outermost member of a path on `api`: what it names, called or not; its inner members are not visited.
      if (named) return void found.push({ ...named, via: "api", file, ...at(node.start) });
    } else if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      // `createFileRoute(id)({ … })`: its page, and what its options say of the sitemap.
      const maker = callee?.type === "CallExpression" ? unwrap(callee.callee) : undefined;
      const madeId =
        maker?.type === "Identifier" && ROUTE_MAKERS.has(maker.name) && page === undefined
          ? stringValue(callee.arguments[0])
          : undefined;
      if (madeId !== undefined) {
        page = pageOf(madeId);
        const listed = maker.name === "createFileRoute" ? sitemapOf(node.arguments[0]) : undefined;
        const rank = madeId.endsWith("/") ? 2 : isPathless(madeId.split("/").at(-1)!) ? 0 : 1;
        if (listed !== undefined && rank) says = { listed, rank };
      }
      if (callee?.type === "Identifier" && ROUTE_MAKERS.has(callee.name) && page === undefined) {
        const id = stringValue(node.arguments[0]);
        if (id !== undefined) page = pageOf(id);
      }
      const kind = contentKind(callee, content);
      if (kind !== undefined) gets.push({ kind, arg: unwrap(node.arguments[0]), start: node.start });
    } else if (node.type === "JSXOpeningElement" && node.name.type === "JSXIdentifier" && runForm.has(node.name.name)) {
      const attribute = node.attributes.find(
        (a: Node) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "workflow",
      );
      const value = attribute?.value?.type === "JSXExpressionContainer" ? attribute.value.expression : attribute?.value;
      const name = stringValue(value);
      if (name !== undefined) found.push({ kind: "workflow", name, via: "RunForm", file, ...at(node.start) });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(program);
  const uses = found.map((use) => (page === undefined ? use : { ...use, page }));
  if (page === undefined) return { uses };
  const route: FileRoute = { path: page, ...(says && { says }) };
  // The one parameter's name (not a splat's), and the kinds whose `get` is given it (`params.slug`, or `slug` destructured).
  const params = page.split("/").filter((segment) => segment.startsWith("$"));
  if (params.length !== 1 || params[0] === "$") return { uses, route };
  const param = params[0]!.slice(1);
  const kinds = new Set(
    gets
      .filter(({ arg }) =>
        arg?.type === "Identifier"
          ? arg.name === param
          : arg?.type === "MemberExpression" && memberPath(arg, PARAMS)?.join(".") === param,
      )
      .map(({ kind }) => kind),
  );
  if (kinds.size === 1) return { uses, route: { ...route, content: [...kinds][0]! } };
  // A read by the parameter in a form the sitemap does not follow (`params.id.toLowerCase()`, two kinds).
  const unfollowed = gets.find(({ arg }) => mentions(arg, param));
  if (!unfollowed) return { uses, route };
  const message =
    `the sitemap lists none of this page's entries: it reads content by the page's parameter in a way it cannot follow. ` +
    `Read one kind by it as written, \`content.<kind>.get(params.${param})\` (or \`${param}\` destructured)`;
  return { uses, route, warning: { file, ...at(unfollowed.start), message } };
}

/** A route's `options`' `staticData: { sitemap }`, each written out, `sitemap` a boolean; undefined for any other. */
const sitemapOf = (options: Node): boolean | undefined => {
  const flag = unwrap(valueOf(valueOf(options, "staticData"), "sitemap"));
  return flag?.type === "Literal" && typeof flag.value === "boolean" ? flag.value : undefined;
};

/**
 * The value of an object literal's property `name`, its last, written out; undefined for anything
 * else, or when a spread or a computed key after it could replace it.
 */
const valueOf = (object: Node, name: string): Node => {
  const o = unwrap(object);
  const last =
    o?.type === "ObjectExpression" && o.properties.findLast((p: Node) => !isWritten(p) || keyName(p.key) === name);
  return last && isWritten(last) ? last.value : undefined;
};

/** Whether `node` reads the parameter `param` anywhere in it: `params.<param>`, or `param` destructured (not another parameter, nor a property's name, `post.slug` or `{ slug: x }`). */
const mentions = (node: Node, param: string): boolean => {
  if (!node) return false;
  if (node.type === "Identifier") return node.name === param;
  if (node.type === "Property" && !node.computed) return mentions(node.value, param);
  if (node.type === "MemberExpression") {
    const path = memberPath(node, PARAMS);
    if (path) return path[0] === param;
    if (!node.computed) return mentions(node.object, param);
  }
  return childrenOf(node).some((child) => mentions(child, param));
};

/** The names of a member path on one of `roots` (`api.data.leads.list` is `data`, `leads`, `list`); undefined for a path on anything else or a name not written out. */
function memberPath(member: Node, roots: ReadonlySet<string>): string[] | undefined {
  const path: string[] = [];
  let node = member;
  while (node?.type === "MemberExpression") {
    const key: string | undefined = node.computed ? stringValue(node.property) : node.property.name;
    if (key === undefined) return undefined;
    path.unshift(key);
    node = unwrap(node.object);
  }
  return node?.type === "Identifier" && roots.has(node.name) ? path : undefined;
}

/** The kind of `content.<kind>.get`, a callee on `content` imported from `sanoma/site`; undefined for any other. */
function contentKind(callee: Node, content: ReadonlySet<string>): string | undefined {
  const path = callee?.type === "MemberExpression" ? memberPath(callee, content) : undefined;
  return path?.length === 2 && path[1] === "get" ? path[0] : undefined;
}

/** What a member path on `api` names; undefined for a path on anything else, a name not written out, or no name. */
function apiPath(member: Node, api: ReadonlySet<string>): Pick<Written, "kind" | "name" | "method"> | undefined {
  const path = memberPath(member, api);
  if (!path?.length) return undefined;
  const [first, second] = path as [string, ...string[]];
  // `api.data.<collection>.<op>`, or an app's, `api.data.<app>.<collection>.<op>`.
  if (first === DATA_VENDOR)
    return path.length === 3 || path.length === 4
      ? { kind: "collection", name: path.slice(1, -1).join("."), method: path.at(-1) }
      : undefined;
  if (path.length === 3) return { kind: "op", name: path.join(".") };
  if (path.length > 2) return undefined;
  return { kind: "workflow", name: first, ...(second !== undefined && { method: second }) };
}

/** The local names `imported` has in the file, imported as a value from one of `sources`. */
function importedAs(program: Node, sources: ReadonlySet<string>, imported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!sources.has(statement.source.value)) continue;
    for (const s of statement.specifiers) {
      if (s.type === "ImportSpecifier" && s.importKind !== "type" && keyName(s.imported) === imported) {
        names.add(s.local.name);
      }
    }
  }
  return names;
}

/** The connectors a site's `login` is checked against: the config's vendors, and those with a login half. */
type SiteConnectors = { vendors: ReadonlySet<string>; logins: ReadonlySet<string> };

/** A property of an object literal that is written out: not a spread, its name not computed. */
const isWritten = (p: Node) => p.type === "Property" && !p.computed;

/** What `site.ts`'s default export, `defineSite({ … })`, may say. */
const SiteDefinitionSchema = z.strictObject({
  title: z.string().optional(),
  icon: z.string().optional(),
  public: z.boolean().optional(),
  login: z.string().optional(),
  locales: z.array(z.string()).optional(),
});

/**
 * What the site in `dir` (relative to `root`) says of itself in its `site.ts`, loaded
 * (`loadModules`, `defineSite` served from `sanoma/site`), and what is wrong there: its default
 * export, `defineSite({ … })`, held to its schema; then a `login` on a site that is not public, or
 * naming no connector of the config with a login half, and `locales` that are not a public site's
 * (with no login) language tags, each once. `locales` is kept only when it has no problem. Nothing
 * for no file, or no default export.
 */
function siteDefinitionOf(
  root: string,
  dir: string,
  connectors: SiteConnectors,
): Pick<SiteEntry, "at" | "title" | "icon" | "public" | "login" | "locales"> & {
  problems: (ResourceProblem & { file: string })[];
} {
  const file = `${dir}/site.ts`;
  if (!existsSync(join(root, file))) return { problems: [] };
  // A helper it imports threw: said at the helper.
  const loaded = exportsOf(loadModules(root, [join(root, file)], []), file);
  if (loaded === undefined) return { problems: [] };
  if ("problem" in loaded) return { problems: [loaded.problem] };
  const value = loaded.exports.find(([name]) => name === "default")?.[1];
  if (value === undefined) return { problems: [] };
  const problem = (message: string) => ({ file, export: "default", message });
  const parsed = SiteDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    const why = z.prettifyError(parsed.error).replaceAll(/\s*\n\s*/g, " ");
    return { problems: [problem(`its default export is \`defineSite({ … })\` from "sanoma/site": ${why}`)] };
  }
  const { title, icon, public: isPublic, login, locales } = parsed.data;
  const problems: (ResourceProblem & { file: string })[] = [];
  const loginProblem = (): string | undefined => {
    if (!isPublic) return "a login is for a public site: add `public: true`, or remove `login`";
    if (!connectors.vendors.has(login!)) return `login names "${login}", which is not a connector in sanoma.config.ts`;
    if (!connectors.logins.has(login!)) return `login names "${login}", whose connector has no login half`;
    return undefined;
  };
  const loginMessage = login !== undefined ? loginProblem() : undefined;
  if (loginMessage) problems.push(problem(loginMessage));
  const localesProblem = (list: string[]): string | undefined => {
    if (!list.length) return "`locales` names a site's languages, its default first: give one or more, or remove it";
    const bad = list.find((locale) => !LOCALE.test(locale));
    if (bad !== undefined) return `"${bad}" is not a language tag such as "en", "fr" or "pt-BR"`;
    const twice = list.find((locale, i) => list.indexOf(locale) !== i);
    if (twice !== undefined) return `"${twice}" is in \`locales\` twice`;
    if (!isPublic || login !== undefined) {
      return "`locales` are for a public site with no login: add `public: true`, or remove `locales`";
    }
    return undefined;
  };
  const localesMessage = locales && localesProblem(locales);
  if (localesMessage) problems.push(problem(localesMessage));
  return {
    at: { file, export: "default" },
    ...(title !== undefined && { title }),
    ...(icon !== undefined && { icon }),
    ...(isPublic && { public: true as const }),
    ...(login !== undefined && { login }),
    ...(locales && !localesMessage && { locales }),
    problems,
  };
}

/**
 * A route's path from its id, as the router serves it: `(group)` and `_pathless` segments left
 * out, a `_` that ends a segment dropped, and no trailing slash.
 */
const pageOf = (id: string): string =>
  `/${id
    .split("/")
    .filter((s) => s && !isPathless(s))
    .map((s) => s.replace(/_$/, ""))
    .join("/")}`;

/** A route id's segment the router's path leaves out: a `(group)` or a `_pathless` one. */
const isPathless = (segment: string): boolean => /^\(.*\)$/.test(segment) || segment.startsWith("_");

/** A site's source file: `.ts` or `.tsx`, but a test or a declaration. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name);
