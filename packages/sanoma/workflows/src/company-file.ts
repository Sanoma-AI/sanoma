import { bundledFile, rootSnapshot } from "./bundled.ts";
import { APPS_DIR, appOfPath } from "./shared.ts";

// Which company file declared a workflow or a collection, and the app it is in. Node's modules are
// read where a function needs them (`process.getBuiltinModule`, which workerd has too), never
// imported: a page's bundle (`page-run.ts`) declares the company's workflows and collections as
// well, and has none. There, a file is the one the bundle says it is evaluating (`bundledFile`),
// which a page's build names from the company's root (`apps/crm/resources/data.ts`).

/** Node's built-in module `id`, where there is a Node (or workerd); undefined in a browser. */
const builtin = <K extends "node:fs" | "node:path" | "node:url" | "node:util">(id: K) =>
  globalThis.process?.getBuiltinModule?.(id);

/**
 * What `found` returns for the nearest of `dir` and its ancestors for which it returns something,
 * nearest first; undefined when it returns nothing for any. The one walk up the directories.
 */
export function upFrom<T>(dir: string, found: (dir: string) => T | undefined): T | undefined {
  const { dirname } = builtin("node:path")!;
  for (;;) {
    const value = found(dir);
    if (value !== undefined) return value;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The file of the code that called the function calling this one (`defineWorkflow`'s caller),
 * from V8's call sites, as a path; where they name none, or there are none (a page), the file a
 * bundle says it is evaluating (`bundledFile`); undefined where there is neither.
 */
export function callerFile(): string | undefined {
  // Frame 0 is this function, frame 1 its caller, frame 2 theirs: by index, since a bundle may hold all three.
  return scriptPath(builtin("node:util")?.getCallSites(3)[2]?.scriptName) ?? bundledFile();
}

/** A V8 script name (a `file:` URL for a module, a path for a script) as a path; undefined for none. */
export function scriptPath(script: string | undefined): string | undefined {
  if (!script?.startsWith("file:")) return script || undefined;
  try {
    return builtin("node:url")?.fileURLToPath(script);
  } catch {
    return undefined;
  }
}

/** Each directory's company root (the nearest one with a `sanoma.config.ts`, short of a `node_modules`), once found. */
const roots = new Map<string, string>();

/** Whether `dir` is a company's root: it holds a `sanoma.config.ts`, or a bundle registered its snapshot (`useRootSnapshot`). */
function isCompany(dir: string): boolean {
  const { existsSync } = builtin("node:fs")!;
  return rootSnapshot(dir) !== undefined || existsSync(builtin("node:path")!.join(dir, "sanoma.config.ts"));
}

/**
 * The nearest of `dir` and its ancestors with a `sanoma.config.ts` (or a bundle's snapshot), where a
 * `node_modules` ends the search (what is under it is a package's, not a company's): a company's
 * root, or an app's in `apps/<app>/` that kept its own config. Undefined outside any, and where
 * there is no Node (a page).
 */
export function configDirOf(dir: string): string | undefined {
  const path = builtin("node:path");
  if (!path) return undefined;
  const { basename, resolve } = path;
  return (
    upFrom<string | null>(resolve(dir), (d) =>
      basename(d) === "node_modules" ? null : isCompany(d) ? d : undefined,
    ) ?? undefined
  );
}

/**
 * The root of the company `dir` is in: its `configDirOf`, unless that is an app merged from a
 * company's repo, which keeps that repo's config: a root in `apps/<app>/` of a company is that
 * company's. Undefined outside any company, and where there is no Node (a page).
 */
export function companyRootOf(dir: string): string | undefined {
  const path = builtin("node:path");
  if (!path) return undefined;
  const { basename, dirname, resolve } = path;
  dir = resolve(dir);
  const known = roots.get(dir);
  if (known !== undefined) return known;
  let root = configDirOf(dir);
  if (root === undefined) return undefined;
  // An app merged from a company's repo keeps that repo's config: the company is the one above.
  if (basename(dirname(root)) === APPS_DIR && isCompany(dirname(dirname(root)))) root = dirname(dirname(root));
  // Found roots only: a directory that is no company's yet may become one (`sanoma` in an empty folder).
  roots.set(dir, root);
  return root;
}

/**
 * The app a file is in: `<app>` for a file under `<root>/apps/<app>/`, where the root is its
 * company's (`companyRootOf`: an app keeps its own `package.json`, and its own config when merged
 * from a company's repo); undefined for a file at the root or outside any company. `defineWorkflow`
 * and `collection()` name what they declare by it. In a page, which has no files, the file is named
 * from the root, and its app is read from that.
 */
export function appOfFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const path = builtin("node:path");
  // A page's file is named from the root (`apps/crm/resources/data.ts`), in a browser or in Node.
  if (!path?.isAbsolute(file)) return appOfPath(file);
  const { dirname, relative, resolve, sep } = path;
  const root = companyRootOf(dirname(resolve(file)));
  return root === undefined ? undefined : appOfPath(relative(root, file).split(sep).join("/"));
}
