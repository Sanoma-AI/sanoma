import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How the bin was called, or what it found where it was called: exit 2. */
export class UsageError extends Error {}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface Package {
  name: string;
  /** Its directory in the checkout. */
  dir: string;
}

const readManifest = (dir: string): Manifest | undefined => {
  const file = join(dir, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : undefined;
};

/** The repo's `dependencies` and `devDependencies`, by name. */
const deps = (root: string): Record<string, string> => {
  const { dependencies, devDependencies } = readManifest(root) ?? {};
  return { ...dependencies, ...devDependencies };
};

/** Whether `name` is `sanoma` or a `@sanoma-ai/*` package. */
const ours = (name: string) => name === "sanoma" || name.startsWith("@sanoma-ai/");

/** A `UsageError` unless `cwd` holds a `sanoma.config.ts` and a `package.json`: a repo's root. */
export function checkRepo(cwd: string): void {
  if (!existsSync(join(cwd, "sanoma.config.ts")) || !existsSync(join(cwd, "package.json"))) {
    throw new UsageError(`No sanoma.config.ts and package.json in ${cwd}: run sanoma-dev from the repo's root`);
  }
}

/** Whether `dir` is a sanoma checkout: its `packages/sanoma/package.json` is named `sanoma`. */
export const isCheckout = (dir: string) => readManifest(join(dir, "packages/sanoma"))?.name === "sanoma";

/**
 * The packages `sanoma-dev` links: `sanoma` and each `@sanoma-ai/*` the repo's `package.json`
 * declares (`dependencies` or `devDependencies`), but `@sanoma-ai/dev` itself. Only declared ones:
 * linking a package the repo does not declare makes pnpm add a `link:` dependency.
 */
export const declared = (root: string): string[] =>
  Object.keys(deps(root)).filter((name) => ours(name) && name !== "@sanoma-ai/dev");

/** Where package `name` is in a sanoma checkout: `connectors/<short name>` or `packages/<short name>`. */
export function dirIn(checkout: string, name: string): string {
  const short = name.replace(/^@sanoma-ai\//, "");
  return short.startsWith("connector-")
    ? join(checkout, "connectors", short.slice("connector-".length))
    : join(checkout, "packages", short);
}

/** The repo's declared packages (`declared`) split by whether the checkout has them. */
export function linkSet(root: string, checkout: string): { found: Package[]; missing: string[] } {
  const found: Package[] = [];
  const missing: string[] = [];
  for (const name of declared(root)) {
    const dir = dirIn(checkout, name);
    if (readManifest(dir)?.name === name) found.push({ name, dir });
    else missing.push(name);
  }
  return { found, missing };
}

/** An `overrides` line of `pnpm-workspace.yaml` linking a package: its name, quoted or not. */
const OVERRIDE = /^\s*['"]?([^'":\s]+)['"]?\s*:\s*['"]?link:/;

/**
 * What a link of `sanoma` or a `@sanoma-ai/*` package leaves behind that must not be committed:
 * each such `link:` dependency in `package.json`, and each such line of `pnpm-workspace.yaml` (the
 * `overrides` a `pnpm link` adds). Links of other packages are the repo's own business.
 */
export function leftoverLinks(root: string): string[] {
  const workspace = join(root, "pnpm-workspace.yaml");
  return [
    ...Object.entries(deps(root))
      .filter(([name, spec]) => ours(name) && spec.startsWith("link:"))
      .map(([name, spec]) => `package.json: "${name}": "${spec}"`),
    ...(existsSync(workspace) ? readFileSync(workspace, "utf8").split("\n") : [])
      .filter((line) => ours(OVERRIDE.exec(line)?.[1] ?? ""))
      .map((line) => `pnpm-workspace.yaml: ${line.trim()}`),
  ];
}
