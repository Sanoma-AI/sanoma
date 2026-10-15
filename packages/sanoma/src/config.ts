import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig, SanomaConfig } from "@sanoma-ai/workflows";

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
      `${file} must export a config as its default export: \`export default defineConfig({ workflows, connectors, policy })\``,
    );
  }
  config.file ??= file;
  return { config, root: config.root ?? dirname(file) };
}

const isConfig = (x: unknown): x is SanomaConfig =>
  typeof x === "object" && x !== null && "workflows" in x && "connectors" in x && "policy" in x;
