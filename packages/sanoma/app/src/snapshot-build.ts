// The app's snapshot made from the company's files, Node only: what `buildAppBundle` bakes into
// the Worker's bundle, and what the Node adapter (`startApp`) makes at start and again once a file
// it read changed (`liveSnapshot`). Reading the files, git and the network happens here, never in
// a request.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  defaultBranch,
  errorMessage,
  filesUnder,
  hostRootFacts,
  kindDirs,
  readRootSnapshot,
  type ResolvedConfig,
  resolveConfig,
  type SanomaConfig,
  type Source,
  sourceRepository,
  valueAt,
} from "sanoma/workflows";
import { type ConfigDescription, describeConfig, liveDescription, readLockfile } from "sanoma/workflows/describe";
import { loadScenarios } from "sanoma/workflows/scenario";
import { INFRA, type ScenariosResponse } from "./api.ts";
import { contentFields, publishedOf } from "./content-files.ts";
import { type AppSnapshot, withoutSources } from "./snapshot.ts";

export interface SnapshotOptions {
  /** The company's repository (`AppOptions.source`): its remote, and the workflows' paths in it. */
  source?: Source;
  /** The description to make it from: `describeConfig(config)` when not given. */
  description?: ConfigDescription;
  /** Each repository's default branch by clone URL, as read before (`git ls-remote` asks the network). */
  branches?: Map<string, Promise<string | undefined>>;
}

/** A snapshot and the files and folders it was read from, each with its stamp then. */
interface Made {
  snapshot: AppSnapshot;
  stamps: Map<string, string>;
}

// Kept beside `made`: it resolves the config and drops the stamps, for the bundle's build and the tests.
/** The company as the app reads it (`AppSnapshot`), from its files now. */
export async function appSnapshot(config: SanomaConfig, options: SnapshotOptions = {}): Promise<AppSnapshot> {
  return (await made(config, resolveConfig(config), options)).snapshot;
}

/**
 * The snapshot, made again on a call once a file it was made from changed: the description as
 * `liveDescription` keeps it (the data files, the sites, the lockfile), and the sources, the
 * feature files, `content/`, `infra.ts` and the repository's `.git/config` (its remote), by size
 * and modification time, a `stat` each. What the Node adapter hands each request.
 */
export async function liveSnapshot(
  config: SanomaConfig,
  options: Omit<SnapshotOptions, "description"> = {},
): Promise<() => Promise<AppSnapshot>> {
  const resolved = resolveConfig(config);
  const describe = liveDescription(config);
  const branches = options.branches ?? new Map<string, Promise<string | undefined>>();
  const make = (description: ConfigDescription) => made(config, resolved, { ...options, description, branches });
  let described = describe();
  let now = await make(described);
  /** The make under way, and the description it is of. */
  let making: { description: ConfigDescription; made: Promise<Made> } | undefined;
  const remake = (description: ConfigDescription) => {
    const started = {
      description,
      // The snapshot moves on only with a make that finished, so a failed one is tried again.
      made: make(description)
        .then((next) => {
          described = description;
          now = next;
          return next;
        })
        .finally(() => {
          if (making === started) making = undefined;
        }),
    };
    return (making = started).made;
  };
  return async () => {
    const description = describe();
    // Made again once the description is another, or a path's stamp is not the one it had.
    if (description !== described || [...now.stamps].some(([path, stamp]) => stampOf(path) !== stamp)) {
      // A make of what was there before is waited for, then this one made after it.
      if (making && making.description !== description) await making.made.catch(() => undefined);
      await (making?.description === description ? making.made : remake(description));
    }
    return now.snapshot;
  };
}

async function made(config: SanomaConfig, resolved: ResolvedConfig, options: SnapshotOptions): Promise<Made> {
  const { root } = resolved;
  const full = options.description ?? describeConfig(config);
  const description = withoutSources(full);
  // Each file and folder read, stamped before it is read: one changed while it was read is found changed after.
  const stamps = new Map<string, string>();
  const touch = (path: string) => {
    if (!stamps.has(path)) stamps.set(path, stampOf(path));
  };
  const text = (path: string) => {
    touch(path);
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const sources: Record<string, string> = {};
  for (const workflow of full.workflows) {
    if (!("file" in workflow.outline)) continue;
    const file = workflow.outline.file;
    const found = text(file);
    if (found !== undefined) sources[file] = found.replaceAll("\r\n", "\n");
  }
  if (root !== undefined) {
    const named = [
      ...full.resources.map((r) => r.file),
      ...full.collections.flatMap((c) => (c.declared ? [c.declared.file] : [])),
      ...full.sites.flatMap((site) => (site.at ? [site.at.file] : [])),
      ...full.apps.flatMap((app) => (app.at ? [app.at.file] : [])),
      ...full.problems.flatMap((p) => (p.file ? [p.file] : [])),
    ];
    for (const file of new Set(named)) {
      const found = text(join(root, file));
      if (found !== undefined) sources[file] = found;
    }
    for (const dir of [...kindDirs(root, "scenarios"), join(root, "content")]) touch(dir);
  }
  // The repository's remote is in its git config: a remote added or changed is a new snapshot.
  if (options.source) touch(gitConfig(options.source.root));
  const infra = root === undefined ? null : (text(join(root, INFRA)) ?? null);
  const branches = options.branches ?? new Map<string, Promise<string | undefined>>();
  const [scenarios, repository, host] = await Promise.all([
    scenariosOf(resolved),
    repositoryOf(resolved, options.source),
    root === undefined ? undefined : hostOf(root, resolved, description, branches),
  ]);
  const snapshot: AppSnapshot = {
    ...(root === undefined ? rootless(resolved) : readRootSnapshot(config, resolved)),
    description,
    sources,
    scenarios,
    content: root === undefined ? [] : contentFields(root),
    published: root === undefined ? {} : publishedOf(root),
    ...(repository && { repository }),
    infra,
    bound: root === undefined ? [] : Object.keys(readLockfile(root).bindings),
    ...(host && { host }),
  };
  return { snapshot, stamps };
}

/** A config with no root's part of the snapshot: no files, so no policies or people. */
const rootless = ({ appName, version, builtInCodes }: ResolvedConfig) => ({
  appName,
  version,
  builtInCodes,
  policies: [],
  checkedPolicies: { policies: [], problems: [] },
  people: { people: [], problems: [] },
});

/** The scenarios as the page lists them: none, with why as the one error, when they cannot be read. */
export async function scenariosOf(resolved: ResolvedConfig): Promise<ScenariosResponse> {
  try {
    const loaded = await loadScenarios(resolved);
    return {
      scenarios: loaded.scenarios.map(({ name, workflow, file, text, steps, input }) => ({
        name,
        workflow,
        file,
        text,
        steps,
        input,
      })),
      errors: loaded.errors,
    };
  } catch (err) {
    return { scenarios: [], errors: [{ file: "", message: errorMessage(err) }] };
  }
}

/** The repository's remote, its credentials left out, and each workflow's file in it. A remote git cannot read is none, logged. */
async function repositoryOf(resolved: ResolvedConfig, source: Source | undefined) {
  if (!source) return undefined;
  const remote = await Promise.resolve(source.remoteUrl?.()).catch((err: unknown) => {
    console.error("sanoma app: reading the repository's remote failed:", err);
    return undefined;
  });
  const workflows = Object.fromEntries(
    [...resolved.workflows.values()].map((wf) => [wf.name, relative(source.root, wf.file).split(sep).join("/")]),
  );
  return { ...(remote && { remote: withoutCredentials(remote) }), workflows };
}

/** A URL with its user and password left out (an `origin` may hold a token); a path or an scp-like address as it is. */
function withoutCredentials(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

/**
 * What the declared hosts that derive are filled from at the root (`hostRootFacts`), and the
 * default branch of each repository one may run from with no `ref` declared: `origin`, the
 * repository it references (or `deriveHosts` gives it: `sourceRepository`), or the URL it names.
 * Undefined when no declared host derives.
 */
async function hostOf(
  root: string,
  { types }: ResolvedConfig,
  description: ConfigDescription,
  branches: Map<string, Promise<string | undefined>>,
): Promise<AppSnapshot["host"]> {
  const typeOf = (vendor: string, type: string) => types.get(`${vendor}.${type}`);
  const hosts = description.resources.filter((r) => typeOf(r.vendor, r.type)?.host?.derives);
  if (!hosts.length) return undefined;
  const facts = await hostRootFacts(root);
  const urls = new Set<string>();
  for (const host of hosts) {
    const type = typeOf(host.vendor, host.type)!;
    const { inputs } = type.host!;
    if (inputs.ref !== undefined && valueAt(host.desired, inputs.ref)) continue;
    if (facts.origin) urls.add(facts.origin);
    const repository =
      host.refs[inputs.source] !== undefined
        ? description.resources.find((r) => r.id === host.refs[inputs.source])
        : sourceRepository(host, type, description.resources, facts.origin);
    if (repository?.identity) urls.add(`https://github.com/${repository.identity}.git`);
    const named = valueAt(host.desired, inputs.source);
    if (typeof named === "string" && named) urls.add(named);
  }
  const found = await Promise.all(
    [...urls].map(async (url) => {
      let branch = branches.get(url);
      if (!branch) {
        // A lookup that failed (offline, a rate limit) is asked again by the next snapshot.
        branch = defaultBranch(url).then(
          ({ ref }) => ref,
          () => void branches.delete(url),
        );
        branches.set(url, branch);
      }
      return [url, await branch] as const;
    }),
  );
  return {
    ...facts,
    branches: Object.fromEntries(found.flatMap(([url, ref]) => (ref ? [[url, ref]] : []))),
  };
}

/**
 * The repository's git config, where its remotes are: `.git/config`, or in a worktree (whose
 * `.git` is a file naming its folder in the main repository) the main repository's.
 */
function gitConfig(root: string): string {
  const dotGit = join(root, ".git");
  try {
    const named = readFileSync(dotGit, "utf8").match(/^gitdir: (.+)$/m)?.[1];
    if (named) {
      const dir = resolve(root, named.trim());
      const common = join(dir, "commondir");
      return join(existsSync(common) ? resolve(dir, readFileSync(common, "utf8").trim()) : dir, "config");
    }
  } catch {
    // A folder (the usual checkout) or none.
  }
  return join(dotGit, "config");
}

/** A file's or folder's size and modification time (a folder's: every file under it), or that it is gone. */
function stampOf(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory()) return `${stat.size}:${stat.mtimeNs}`;
    return filesUnder(path, () => true)
      .map((file) => `${file}=${stampOf(file)}`)
      .join("\n");
  } catch {
    return "gone";
  }
}
