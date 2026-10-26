import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig, SanomaConfig, WorkflowDefinition } from "@sanoma-ai/workflows";
import type { Collection } from "@sanoma-ai/workflows/data";

/** A mistake in how the bin was called or in what it found: its message is printed alone, and the exit code is 2. */
export class UsageError extends Error {}

export interface LoadedConfig {
  config: SanomaConfig;
  /** The config's directory: its `root`, else the file's. Data files are `resources/` in it. */
  root: string;
}

/** The config, loaded once, and resolved once (`resolveConfig`): what the commands that read it take. */
export interface Loaded extends LoadedConfig {
  resolved: ResolvedConfig;
}

/**
 * Loads `<cwd>/sanoma.config.ts`, after `<cwd>/.env` when there is one (`process.loadEnvFile`:
 * a variable already set wins). The module's default export is the config; it is not run
 * through `defineConfig` again, since the config module's own call recorded its `file`, and a
 * config made without it gets this file as its `file`. Throws a `UsageError` when the file is
 * missing or its default export is no config.
 *
 * Then every `.ts` file under `<root>/workflows/` and each app's `apps/<app>/workflows/` is
 * imported by its real path: a default export is a workflow (`defineWorkflow`), added to the
 * config's `workflows` (one it lists already is kept, once; two of one name are `resolveConfig`'s
 * to refuse), and a file without one is a helper. A default export that is no workflow is a
 * `UsageError` naming the file.
 *
 * Then `<root>/resources/data.ts` and each app's `apps/<app>/resources/data.ts`, when there is
 * one, is imported by its real path, as the workflows that name its collections import it: each
 * of its exports is a collection, added to the config's `collections` (one it lists already is
 * kept, once). An export that is not a collection is a `UsageError` naming the file.
 */
export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const env = join(cwd, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  if (!existsSync(join(cwd, "sanoma.config.ts"))) {
    throw new UsageError(`No sanoma.config.ts in ${cwd}: run sanoma from the directory that holds it`);
  }
  // Node names a module by its real path, and so does the config's own `file`: the same here.
  const file = join(realpathSync(cwd), "sanoma.config.ts");
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const config = mod.default;
  if (!isConfig(config)) {
    throw new UsageError(
      `${file} must export a config as its default export: \`export default defineConfig({ connectors })\``,
    );
  }
  config.file ??= file;
  const root = config.root ?? dirname(file);
  // Imported here, not at the top: `cli.ts` loads this module before any command needs the runtime.
  const { filesUnder, isCollection, kindDirs } = await import("@sanoma-ai/workflows");
  // A `workflows` or `collections` that is no list is resolveConfig's to explain.
  if (config.workflows === undefined || Array.isArray(config.workflows)) {
    const workflows = new Set(config.workflows);
    for (const path of kindDirs(root, "workflows").flatMap((dir) => filesUnder(dir, isSource))) {
      const { default: wf } = (await importReal(path)) as { default?: unknown };
      if (wf === undefined) continue;
      if (!isWorkflow(wf)) {
        throw new UsageError(
          `${realpathSync(path)}'s default export is not a workflow: a file of workflows/ exports one, \`export default defineWorkflow({ … })\`, or none (a helper the workflows import)`,
        );
      }
      workflows.add(wf);
    }
    if (workflows.size > 0) config.workflows = [...workflows];
  }
  if (config.collections === undefined || Array.isArray(config.collections)) {
    const collections = new Set<Collection>(config.collections);
    for (const path of kindDirs(root, "resources").map((dir) => join(dir, "data.ts"))) {
      if (!existsSync(path)) continue;
      for (const [name, value] of Object.entries((await importReal(path)) as Record<string, unknown>)) {
        if (!isCollection(value)) {
          throw new UsageError(
            `${realpathSync(path)} exports ${name}, which is not a collection: resources/data.ts holds collections only, each \`export const ${name} = collection({ name, key, fields })\` with collection from "sanoma/data"`,
          );
        }
        collections.add(value);
      }
    }
    if (collections.size > 0) config.collections = [...collections];
  }
  return { config, root };
}

/** The module at `path`, imported by its real path: the module a relative import of it is. */
const importReal = (path: string): Promise<unknown> => import(pathToFileURL(realpathSync(path)).href);

/** A workflow file's name: `.ts`, but a test (`.test.ts`, `.spec.ts`) or a declaration. */
const isSource = (name: string) => name.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(name);

const isWorkflow = (x: unknown): x is WorkflowDefinition =>
  typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "workflow";

const isConfig = (x: unknown): x is SanomaConfig => typeof x === "object" && x !== null && "connectors" in x;
