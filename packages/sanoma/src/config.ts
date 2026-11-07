import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig, SanomaConfig } from "sanoma/workflows";

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
  const { declarationFiles, errorMessage, joinDeclarations } = await import("sanoma/workflows");
  const files = declarationFiles(root);
  // The workflows' first; joined in the files' order.
  const modules = { workflows: await importReal(files.workflows), data: await importReal(files.data) };
  try {
    joinDeclarations(config, modules);
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }
  return { config, root };
}

/** The modules at `paths`, at once, each by its real path (the module a relative import of it is), beside it. */
const importReal = (paths: string[]): Promise<[string, object][]> =>
  Promise.all(
    paths.map(async (path): Promise<[string, object]> => {
      const real = realpathSync(path);
      return [real, (await import(pathToFileURL(real).href)) as object];
    }),
  );

const isConfig = (x: unknown): x is SanomaConfig => typeof x === "object" && x !== null && "connectors" in x;
