import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { childrenOf, type Node, readSource } from "./ast.ts";
import { type Loaded, loadModules } from "./load.ts";
import { stringValue } from "./outline.ts";
import { APPS_DIR, filesUnder, inside, isDirectory, RELATIVE } from "./paths.ts";
import type { ResourceProblem } from "./resources.ts";
import { APP_NAME, type At } from "./shared.ts";

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
  /** Its `app.ts`'s default export, when it has the file. */
  at?: At;
}

/** What is wrong with a company's apps, at a file relative to the root. */
export type AppProblem = ResourceProblem & { file: string };

/** The apps under `root` (`appsAt`), without what is wrong with them. */
export const readApps = (root: string | undefined): AppEntry[] => appsAt(root).apps;

/**
 * The apps under `root`: each folder of `apps/` whose name is an `APP_NAME`, sorted, with what is
 * wrong in its `app.ts` and each folder refused for its name as `problems`. Each `app.ts` is
 * loaded (`loadModules`, `defineApp` served from `sanoma`): its default export is
 * `defineApp({ source })`, `source` a string when given.
 */
export function appsAt(root: string | undefined): { apps: AppEntry[]; problems: AppProblem[] } {
  const dir = root === undefined ? undefined : join(root, APPS_DIR);
  if (root === undefined || dir === undefined || !isDirectory(dir)) return { apps: [], problems: [] };
  const apps: AppEntry[] = [];
  const problems: AppProblem[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();
  const named = folders.filter((folder) => APP_NAME.test(folder));
  for (const name of folders.filter((folder) => !APP_NAME.test(folder))) {
    const at = `${APPS_DIR}/${name}`;
    problems.push({
      file: at,
      line: 1,
      column: 1,
      message: `${at} is not an app: an app's folder name is a lowercase letter, then lowercase letters and digits`,
    });
  }
  const files = named.map((name) => join(dir, name, "app.ts")).filter((path) => existsSync(path));
  const loaded = files.length ? loadModules(root, files, []) : new Map<string, Loaded>();
  for (const name of named) {
    const file = `${APPS_DIR}/${name}/app.ts`;
    const read = appDefinitionOf(file, loaded);
    problems.push(...read.problems);
    apps.push({
      name,
      dir: `${APPS_DIR}/${name}`,
      ...(read.source !== undefined && { source: read.source }),
      ...(loaded.has(file) && { at: { file, export: "default" } }),
    });
  }
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { apps, problems };
}

/** What `app.ts`'s default export, `defineApp({ … })`, may say. */
const AppDefinitionSchema = z.strictObject({ source: z.string().optional() });

/** `app.ts`'s `source`, as loading it gave, and what is wrong there; nothing for no file. */
function appDefinitionOf(file: string, answer: Map<string, Loaded>): { source?: string; problems: AppProblem[] } {
  const loaded = answer.get(file);
  if (loaded === undefined) return { problems: [] };
  // A helper it imports threw: said at the helper.
  if ("failedIn" in loaded) return appDefinitionOf(loaded.failedIn, answer);
  if ("error" in loaded) {
    const { error, line, column } = loaded;
    const message = error instanceof Error ? error.message : String(error);
    return {
      problems: [
        {
          file,
          ...(line !== undefined && { line, column: column ?? 1 }),
          message: message.replaceAll(/\s*\n\s*/g, " "),
        },
      ],
    };
  }
  const value = loaded.exports.find(([name]) => name === "default")?.[1];
  const parsed = AppDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    const why = z.prettifyError(parsed.error).replaceAll(/\s*\n\s*/g, " ");
    const message = `its default export is \`defineApp({ source })\` from "sanoma", \`source\` a string: ${why}`;
    return { problems: [{ file, export: "default", message }] };
  }
  return { ...(parsed.data.source !== undefined && { source: parsed.data.source }), problems: [] };
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
