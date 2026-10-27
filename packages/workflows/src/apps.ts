import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { childrenOf, type LintProblem, type Node, readSource } from "./ast.ts";
import { keyName } from "./datafile.ts";
import { stringValue, unwrap } from "./outline.ts";
import { APPS_DIR, filesUnder, inside, isDirectory, RELATIVE } from "./paths.ts";
import { APP_NAME } from "./shared.ts";

// A company's apps: each folder of `apps/` holds the kinds the root does (workflows, resources,
// policies, scenarios, sites), merged from a source repository whose URL its `app.ts` names, or
// made here. What a folder declares is named with the folder (`qualified`): never written, read
// from where the declaration's file is (`appOfFile`).

/** An app: a folder of `apps/`, by its name, and the source repository its `app.ts` names. */
export interface AppEntry {
  /** The folder's name, which prefixes what it declares (`crm.contacts`) and is the app's title. */
  name: string;
  /** The folder, relative to the root, with `/`: `apps/crm`. */
  dir: string;
  /** `defineApp({ source })` in its `app.ts`: the repository it was taken from; absent for the company's own app. */
  source?: string;
}

/** What `app.ts` declares: the source repository's URL, when the app was taken from one. */
export interface AppDefinition {
  source?: string;
}

/**
 * Declares an app in its folder's `app.ts`, read without running it: `defineApp({ source:
 * "https://github.com/acme/crm" })`, the repository it was taken from; `defineApp({})` for an app
 * the company made itself.
 */
export function defineApp(definition: AppDefinition): AppDefinition {
  return Object.freeze({ ...definition });
}

/** What is wrong with a company's apps, at a file relative to the root. */
export type AppProblem = LintProblem & { file: string };

/** The apps under `root` (`appsAt`), without what is wrong with them. */
export const readApps = (root: string | undefined): AppEntry[] => appsAt(root).apps;

/**
 * The apps under `root`: each folder of `apps/` whose name is an `APP_NAME`, sorted, with what is
 * wrong in its `app.ts` and each folder refused for its name as `problems`. `app.ts` is read
 * with oxc, never run: its default export must be `defineApp({ … })`, from `sanoma`, written out,
 * and `source` a string.
 */
export function appsAt(root: string | undefined): { apps: AppEntry[]; problems: AppProblem[] } {
  const dir = root === undefined ? undefined : join(root, APPS_DIR);
  if (dir === undefined || !isDirectory(dir)) return { apps: [], problems: [] };
  const apps: AppEntry[] = [];
  const problems: AppProblem[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();
  for (const name of folders) {
    const at = `${APPS_DIR}/${name}`;
    if (!APP_NAME.test(name)) {
      problems.push({
        file: at,
        line: 1,
        column: 1,
        message: `${at} is not an app: an app's folder name is a lowercase letter, then lowercase letters and digits`,
      });
      continue;
    }
    const read = appOptionsOf(join(dir, name, "app.ts"));
    problems.push(...read.problems.map((p) => ({ file: `${at}/app.ts`, ...p })));
    apps.push({ name, dir: at, ...(read.source !== undefined && { source: read.source }) });
  }
  return { apps, problems };
}

/** Where `defineApp` comes from in `app.ts`. */
const APP_SOURCES: ReadonlySet<string> = new Set(["sanoma", "@sanoma-ai/workflows"]);

/** `app.ts`'s `source`, read without running it, and what is wrong there; nothing for no file. */
function appOptionsOf(path: string): { source?: string; problems: LintProblem[] } {
  if (!existsSync(path)) return { problems: [] };
  const file = readSource(path);
  if (typeof file === "string") return { problems: [{ line: 1, column: 1, message: file }] };
  const problems: LintProblem[] = [...file.problems];
  const problem = (at: Node, message: string) => problems.push({ ...file.at(at.start), message });
  const unread =
    'app.ts is read without running it: its default export is `defineApp({ source })` from "sanoma", written out';
  const exported = file.program.body.find((s: Node) => s.type === "ExportDefaultDeclaration");
  const call = unwrap(exported?.declaration);
  const callee = unwrap(call?.callee);
  const options = unwrap(call?.arguments?.[0]);
  const defineApps = new Set<string>();
  for (const statement of file.program.body) {
    if (statement.type !== "ImportDeclaration" || !APP_SOURCES.has(statement.source.value)) continue;
    for (const s of statement.specifiers) {
      if (s.type === "ImportSpecifier" && keyName(s.imported) === "defineApp") defineApps.add(s.local.name);
    }
  }
  const written =
    call?.type === "CallExpression" &&
    callee?.type === "Identifier" &&
    defineApps.has(callee.name) &&
    (options === undefined || options.type === "ObjectExpression");
  if (!written) {
    problem(exported ?? file.program, unread);
    return { problems };
  }
  const property = options?.properties.findLast(
    (p: Node) => p.type === "Property" && !p.computed && keyName(p.key) === "source",
  );
  const source = property && stringValue(property.value);
  if (property && source === undefined)
    problem(property, "`source` is read without running app.ts: write it as a string");
  return { ...(source !== undefined && { source }), problems };
}

/** A source file under an app: `.ts` or `.tsx`, but a declaration. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts");

/**
 * Each import, from a file under one app's folder, of a file under another's, at its place: a
 * warning, since a company may take one app without the other. Static imports, re-exports and
 * `import("…")` with a literal path; relative specifiers only.
 */
export function crossAppImports(root: string | undefined, apps: readonly AppEntry[]): AppProblem[] {
  if (root === undefined) return [];
  const warnings: AppProblem[] = [];
  for (const app of apps) {
    const own = join(root, app.dir);
    for (const path of filesUnder(own, isSource)) {
      const file = readSource(path);
      if (typeof file === "string") continue;
      const rel = relative(root, path).split(sep).join("/");
      const visit = (node: Node) => {
        if (!node) return;
        const specifier =
          node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ExportNamedDeclaration"
            ? node.source?.value
            : node.type === "ImportExpression"
              ? stringValue(node.source)
              : undefined;
        if (typeof specifier === "string" && RELATIVE.test(specifier)) {
          const target = resolve(dirname(path), specifier);
          const other = apps.find((a) => a !== app && inside(join(root, a.dir), target));
          if (other) {
            warnings.push({
              file: rel,
              ...file.at(node.start),
              message: `imports "${specifier}" from the app ${other.name}: a company may take ${app.name} without it, so reach it through ctx or api instead`,
            });
          }
        }
        for (const child of childrenOf(node)) visit(child);
      };
      visit(file.program);
    }
  }
  return warnings;
}
