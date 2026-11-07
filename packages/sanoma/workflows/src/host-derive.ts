import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { databaseUrlSecret } from "./database.ts";
import { statusesOf } from "./env.ts";
import type { Driver } from "./op.ts";
import type { DeclaredResource, ResourceProblem } from "./description.ts";
import { runtimeImage, sourceKeyId } from "./host.ts";
import type { Bindings } from "./lockfile.ts";
import { type Resource, valueAt } from "./resource.ts";
import { secret, type Secret, type Secrets } from "./secret.ts";
import type { SecretConfiguration } from "./secret-store.ts";
import { sourceKeyPair, sshPublicKey } from "./ssh-key.ts";
import { mintInstanceToken, WAKEUP_TOKEN } from "./wakeup-service.ts";

// What a host that derives (`HostSpec.derives`) is given beyond its decisions: a data file says
// where it runs, its name, its hostname and the database it runs on, and apply fills the rest
// before it plans, as it fills a host's revision. Nothing here is ever a secret's value: the
// secrets a host is given are markers (`secret("NAME")`), resolved by its driver just before the
// vendor call, so a declaration, a plan, a ledger entry or a page holds names only.

/** The private half of the key a host clones a private GitHub repository with: minted at its first apply, held in the store. */
export const SOURCE_KEY = "SANOMA_SOURCE_KEY";

/**
 * Where the company's GitHub App's keys are stored, by what GitHub's manifest conversion calls
 * them: the app's Connect page writes them, the staff login reads the client's, and a host carries
 * the ones that are stored. The one list of them (a connection of its own is later).
 */
export const GITHUB_APP = {
  id: "SANOMA_GITHUB_APP_ID",
  slug: "SANOMA_GITHUB_APP_SLUG",
  client_id: "SANOMA_GITHUB_CLIENT_ID",
  client_secret: "SANOMA_GITHUB_CLIENT_SECRET",
  webhook_secret: "SANOMA_GITHUB_WEBHOOK_SECRET",
  pem: "SANOMA_GITHUB_APP_PEM",
} as const;

/** The signing key a host is given when the config binds none, generated at its create and kept in the store. */
export const HOST_SIGNING_KEY = "SANOMA_HOST_SIGNING_KEY";

/** The wakeup service's URL, which a host is given beside its token when `sanoma.wakeup` wakes it. */
const WAKEUP_URL = "SANOMA_WAKEUP_URL";

/** The type of the key that lets a host clone its GitHub repository, which apply declares on it. */
export const DEPLOY_KEY_TYPE = "github.repository_deploy_key";

/** The title a host's deploy key has on GitHub. */
export const DEPLOY_KEY_TITLE = "Sanoma host";

/** What the runtime knows that a host derives from, read once per apply or drift run (`hostFacts`). */
export interface HostFacts {
  /** The `sanoma` version the repository installs: the runtime image's tag. Undefined when it is not installed. */
  version?: string;
  /** The clone URL of the repository the app runs from (`origin`), with no credentials. */
  origin?: string;
  /** Each public site's domain, by site name (`siteDomains`). */
  domains: Readonly<Record<string, string>>;
  /** True when the config keeps its secrets in the built-in store, which `SANOMA_SECRETS_KEY` unlocks. */
  builtInStore: boolean;
  /**
   * The secrets a host carries for each vendor it deploys itself with (its data file's) or signs
   * people in through (the login's sender), by vendor: the variables the vendor's driver reads
   * that the store holds (one only in this machine's environment is not given to the host).
   */
  carried: ReadonlyMap<string, readonly string[]>;
  /** The login sender's vendor, whose credentials a host carries so it sends sign-in codes. */
  sender?: string;
  /** The company's GitHub App's keys that are stored (`GITHUB_APP`), which a host carries for sign-in and webhooks. */
  githubApp: readonly string[];
  /** The public half of the stored `SANOMA_SOURCE_KEY`, when one is: what apply declares on the repository. */
  sourceKey?: string;
  /**
   * By vendor, the variables its driver reads that are set in this machine's environment but
   * neither bound nor stored: the driver runs here, and a host would not be given them.
   */
  unbound?: ReadonlyMap<string, readonly string[]>;
  /** True when the config binds `SANOMA_SIGNING_KEY`: the host is given that key, else its own (`HOST_SIGNING_KEY`). */
  signingKeyBound?: boolean;
  /** Explicit environment delivery (`host: true`): destination variable to logical secret name, never values. */
  hostEnvironment?: Readonly<Record<string, string>>;
  /** Of `hostEnvironment`'s logical names, those with no value where apply runs: the host cannot be given them. */
  hostEnvironmentUnset?: readonly string[];
  /**
   * While the config has no deploy-key type, the GitHub repositories a host may clone (`origin`'s,
   * a declared `source`'s) that GitHub shows to no one: private (or not there). One GitHub does
   * not answer for is not among them.
   */
  privateRepositories?: readonly string[];
}

const run = promisify(execFile);

/** The version of `sanoma` the repository at `root` installs (a hoisted install counts); undefined when none does. */
export async function installedSanoma(root: string): Promise<string | undefined> {
  try {
    const at = findPackageJSON("sanoma", join(root, "package.json"));
    const version = at && (JSON.parse(await readFile(at, "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A clone URL as a host takes it: GitHub's SSH forms (`git@github.com:o/n.git`,
 * `ssh://git@github.com/o/n`) as `https://github.com/o/n.git`, and any credentials an https URL
 * carries left out (an `origin` may hold a token). Undefined for anything that is not a URL.
 */
export function cloneUrl(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  if (parsed.hostname === "github.com" && !parsed.pathname.endsWith(".git")) parsed.pathname += ".git";
  return parsed.href;
}

/** The URL of `origin` in the git repository at `root`, as a host clones it (`cloneUrl`); undefined when it has none. */
export async function originUrl(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 10_000 });
    return cloneUrl(stdout.trim());
  } catch {
    return undefined;
  }
}

/** The GitHub repository a clone URL names, `owner/name`; undefined for one of another host. */
export function githubRepository(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const at = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(cloneUrl(url) ?? "");
  return at ? `${at[1]}/${at[2]}` : undefined;
}

/**
 * The public half of the source key in `secrets`; with `mint`, a new pair made first when none is
 * stored (its private half stored, never returned), as `sanoma.secret.generate`'s `ssh-rsa` does.
 * Undefined when none is stored and none is minted, or the stored value is no RSA key.
 */
export async function sourceKeyOf(secrets: Secrets, mint: boolean): Promise<string | undefined> {
  let stored = await secrets.get(SOURCE_KEY);
  if (stored === undefined && mint) {
    const pair = await sourceKeyPair();
    stored = await secrets.ensure(SOURCE_KEY, () => pair.privateKey);
  }
  return stored === undefined ? undefined : sshPublicKey(stored);
}

/** Mints the instance token a host's wakeup checks it by, once, when none is stored. */
export const mintWakeupToken = (secrets: Secrets) => secrets.ensure(WAKEUP_TOKEN, mintInstanceToken);

/**
 * The declared repository a host that leaves out its `source` runs from: of the types its
 * `source` reference names, the one `origin` is, else the one the host's own data file declares.
 */
export function sourceRepository(
  host: DeclaredResource,
  type: Resource,
  resources: readonly DeclaredResource[],
  origin: string | undefined,
): DeclaredResource | undefined {
  const named = [type.fields.references?.[type.host!.inputs.source]?.type ?? []].flat();
  const repositories = resources.filter((o) => named.includes(`${o.vendor}.${o.type}`));
  const at = githubRepository(origin);
  const beside = repositories.filter((o) => o.file === host.file);
  return (
    repositories.find((o) => at !== undefined && o.identity === at) ?? (beside.length === 1 ? beside[0] : undefined)
  );
}

/** The declared wakeup that names `host` (its `inputs.host` refers to it), if any. */
export function wokenBy(
  host: Pick<DeclaredResource, "id">,
  resources: readonly DeclaredResource[],
  types: ReadonlyMap<string, Pick<Resource, "wakeup">>,
): DeclaredResource | undefined {
  return resources.find((o) => {
    const wakeup = types.get(`${o.vendor}.${o.type}`)?.wakeup;
    return wakeup !== undefined && o.refs[wakeup.inputs.host] === host.id;
  });
}

/** Sets `value` at the dotted `path` of `into`, making the objects on the way. */
function setAt(into: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let at = into;
  for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
  at[keys.at(-1)!] = value;
}

/** A declaration's export: `host` of `resources/sanoma/infra.ts#host`. */
const exportOf = (id: string) => id.slice(id.indexOf("#") + 1);

/** A repository's name as a host's (`HostSpec.inputs.name`): lower-case letters, digits and dashes. */
const nameOf = (repository: string) =>
  repository
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

/**
 * Fills, in place, each declared host that derives (`HostSpec.derives`) with what it is not told,
 * and puts the deploy key it clones with before it in `resources`:
 *
 * - `name`, left out (when its type takes `inputs.name`): the name it is bound by, else its
 *   repository's (`nameOf`), unless another host of its type has that name;
 * - `image`, left out: the runtime image of the installed `sanoma` (`runtimeImage`);
 * - `source`, left out: the one repository its own data file declares (a reference to it, of a
 *   type its `source` names), else the repository the app runs from (`origin`);
 * - `domains`: each public site's domain (`siteDomains`);
 * - `secrets` (unless it binds its own bootstrap), markers only: the declared `database`'s URL as
 *   `SANOMA_DATABASE_URL`, the runtime's keys (the signing key the config binds, else the host's
 *   own, generated at its create; the encryption key with the built-in store), the source key for
 *   a GitHub repository it can declare a deploy key on, the wakeup's token (and URL, for
 *   `sanoma.wakeup`) when a wakeup names it, the credentials of its own vendor, its repository's
 *   and the login sender's, and the company's GitHub App's keys that are stored;
 * - for a GitHub repository, a `github.repository_deploy_key` (`sourceKeyId`), read-only, whose
 *   key is the stored source key's public half, when one is and the config has the type; found by
 *   its type's identity (the repository and the key), so a key GitHub holds already is bound, not
 *   made again.
 *
 * `ref` is resolved by apply (and drift) with the revision: the repository's default branch.
 * `out.keep` takes the deploy-key ids not declared this read (no source key stored yet, or its
 * host left out), which the caller must not orphan; `out.leftOut` the hosts with a problem, which
 * the caller leaves out, with what names them, so apply changes nothing it cannot give all it needs.
 * Problems: a host with no `database`, a name (none to tell, or another host's), an image or a
 * source that cannot be told, a credential its vendor's driver reads from this machine's
 * environment that nothing binds, a binding given to it (`host: true`) with no value where apply
 * runs, a private repository it has no deploy key for, two hosts that would attach the sites' domains.
 */
export function deriveHosts(
  resources: DeclaredResource[],
  types: ReadonlyMap<string, Resource>,
  bindings: Bindings,
  facts: HostFacts,
  out: { keep?: Set<string>; leftOut?: Set<string> } = {},
): ResourceProblem[] {
  const problems: ResourceProblem[] = [];
  // One host attaches the sites' domains: two would each try to attach them.
  const attaching = resources.filter((r) => {
    const host = types.get(`${r.vendor}.${r.type}`)?.host;
    return host?.derives && host.inputs.domains !== undefined;
  });
  if (attaching.length > 1 && Object.keys(facts.domains).length) {
    for (const r of attaching) {
      out.leftOut?.add(r.id);
      problems.push({
        ...r.at,
        message: `${r.at.export}: ${attaching.length} hosts would attach the public sites' domains: declare one host that derives, the production one`,
      });
    }
  }
  const deployKey = types.get(DEPLOY_KEY_TYPE);
  // A copy: the deploy keys are put in `resources` as it goes.
  for (const r of resources.slice()) {
    const type = types.get(`${r.vendor}.${r.type}`);
    if (!type?.host?.derives) continue;
    const spec = type.host;
    const { inputs } = spec;
    let blocked = out.leftOut?.has(r.id) ?? false;
    const problem = (message: string) => {
      blocked = true;
      problems.push({ ...r.at, message: `${r.at.export}: ${message}` });
    };
    const { desired, refs } = r;

    if (inputs.image !== undefined && valueAt(desired, inputs.image) == null) {
      if (facts.version) setAt(desired, inputs.image, runtimeImage(facts.version));
      else
        problem(
          "its runtime image is the installed sanoma's, and sanoma is not installed: install it, or declare `image`",
        );
    }

    if (valueAt(desired, inputs.source) == null) {
      const declared = sourceRepository(r, type, resources, facts.origin);
      if (declared) {
        setAt(desired, inputs.source, declared.name);
        refs[inputs.source] = declared.id;
      } else if (facts.origin) setAt(desired, inputs.source, facts.origin);
      else
        problem(
          "its source is the repository the app runs from, and the repository has no origin: push it, or declare `source`",
        );
    }
    // The GitHub repository it clones, `owner/name`: a declared one's identity, else its URL's.
    const repositoryId = refs[inputs.source];
    const repository = repositoryId
      ? resources.find((o) => o.id === repositoryId && o.vendor === "github")?.identity
      : githubRepository(valueAt(desired, inputs.source));

    if (inputs.name !== undefined && valueAt(desired, inputs.name) == null) {
      const source = valueAt(desired, inputs.source);
      const named = repository ?? (typeof source === "string" ? cloneUrl(source) : undefined);
      // A bound host keeps the name it is bound by: a renamed repository would otherwise replace it.
      const bound = type.identity === inputs.name ? bindings[r.id]?.id : undefined;
      const name =
        bound ??
        (named &&
          nameOf(
            named
              .replace(/\.git$/, "")
              .split("/")
              .at(-1)!,
          ));
      if (name) {
        setAt(desired, inputs.name, name);
        const identity = type.find?.(desired);
        const twin =
          identity &&
          resources.find((o) => o !== r && o.vendor === r.vendor && o.type === r.type && o.identity === identity);
        if (twin) problem(`its name, its repository's, is ${twin.at.export}'s too, ${name}: declare \`name\``);
        else if (identity) Object.assign(r, { identity, name: identity });
      } else problem("its name is its repository's, and it has none to name it by: declare `name`");
    }

    if (inputs.domains !== undefined && Object.keys(facts.domains).length) {
      setAt(desired, inputs.domains, { ...facts.domains });
    }

    if (spec.bindsBootstrap || inputs.secrets === undefined) {
      if (blocked) out.leftOut?.add(r.id);
      continue;
    }
    // A deploy key is declared for a GitHub repository only where the config has the type.
    const keyed = repository !== undefined && deployKey !== undefined;
    if (repository && !keyed && facts.privateRepositories?.includes(repository)) {
      problem(
        `${repository} is private, and the config has no ${DEPLOY_KEY_TYPE} to give the host a key to clone it with: add the GitHub connector (@sanoma-ai/connector-github) to sanoma.config.ts`,
      );
    }
    const secrets: Record<string, Secret> = {};
    const database = inputs.database === undefined ? undefined : refs[inputs.database];
    if (database) secrets.SANOMA_DATABASE_URL = secret(databaseUrlSecret(exportOf(database)));
    else if (inputs.database !== undefined)
      problem("declare the database it runs on, `database: store`: the host is given its URL");
    secrets.SANOMA_SIGNING_KEY = facts.signingKeyBound
      ? secret("SANOMA_SIGNING_KEY")
      : secret(HOST_SIGNING_KEY, { generate: true });
    if (facts.builtInStore) secrets.SANOMA_SECRETS_KEY = secret("SANOMA_SECRETS_KEY");
    if (keyed) secrets[SOURCE_KEY] = secret(SOURCE_KEY);
    const wakeup = wokenBy(r, resources, types);
    if (wakeup) {
      secrets[WAKEUP_TOKEN] = secret(WAKEUP_TOKEN);
      if (wakeup.vendor === "sanoma") secrets[WAKEUP_URL] = secret(WAKEUP_URL);
    }
    // What it deploys itself with after a push: the vendors of its data file, its repository's, the sender's.
    const vendors = new Set([
      ...resources.filter((o) => o.file === r.file).map((o) => o.vendor),
      ...(repository ? ["github"] : []),
      ...(facts.sender ? [facts.sender] : []),
    ]);
    const carried = [...vendors].flatMap((vendor) => facts.carried.get(vendor) ?? []);
    for (const name of [...carried, ...facts.githubApp]) secrets[name] = secret(name);
    for (const [environment, name] of Object.entries(facts.hostEnvironment ?? {})) {
      const derived = Object.hasOwn(secrets, environment);
      if (derived && secrets[environment]!.$secret !== name)
        problem(`${environment} has a derived host binding and cannot be replaced by ${name}`);
      // Its binding is `{ env }` (`host` takes no other, and none is generated): the variable it is
      // read from where apply runs. Unset, it fails the host's update, a derived one's too.
      else if (facts.hostEnvironmentUnset?.includes(name))
        problem(
          `${name} (\`host: true\`) has no value where apply runs, so the host cannot be given it: set ${environment}, which its binding in sanoma.config.ts reads, or take \`host: true\` off that binding`,
        );
      else if (!derived) Object.defineProperty(secrets, environment, { value: secret(name), enumerable: true });
    }
    // One the driver reads here from the environment alone would be left off the host, and a
    // Worker updated without it would lose it.
    for (const vendor of vendors) {
      for (const name of facts.unbound?.get(vendor) ?? []) {
        if (Object.hasOwn(facts.hostEnvironment ?? {}, name)) continue;
        problem(
          `${name} is read from the environment here, and has no binding, so the host would not be given it: bind it in sanoma.config.ts, \`secrets: { bindings: { ${name}: { env: "${name}" } } }\`, or store it on the ${vendor} connector page`,
        );
      }
    }
    setAt(desired, inputs.secrets, secrets);

    const id = sourceKeyId(r.id);
    // Kept from orphaning while it cannot be declared: no source key stored yet, or the host left out.
    if (keyed && (!facts.sourceKey || blocked)) out.keep?.add(id);
    if (blocked) out.leftOut?.add(r.id);
    // Not twice: a data file of before may declare the same key itself (GitHub takes a key once).
    const declaredKey = resources.some(
      (o) => `${o.vendor}.${o.type}` === DEPLOY_KEY_TYPE && o.desired.key === facts.sourceKey,
    );
    if (keyed && facts.sourceKey && !blocked && !declaredKey) {
      const binding = bindings[id]?.id;
      const key = { repository, title: DEPLOY_KEY_TITLE, key: facts.sourceKey, read_only: true };
      const identity = deployKey.find?.(key);
      resources.splice(resources.indexOf(r), 0, {
        id,
        file: r.file,
        vendor: "github",
        type: "repository_deploy_key",
        name: exportOf(id),
        ...(identity && { identity }),
        ...(binding !== undefined && { binding }),
        at: { file: r.at.file, export: exportOf(id) },
        desired: key,
        refs: repositoryId ? { repository: repositoryId } : {},
      });
    }
  }
  return problems;
}

/**
 * Whether GitHub shows `repository` (`owner/name`) to anyone, asked with no token: false for one
 * that is private (or not there), undefined when GitHub does not say.
 */
async function publicOnGithub(repository: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repository}`, {
      method: "HEAD",
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 200 ? true : res.status === 404 ? false : undefined;
  } catch {
    return undefined;
  }
}

/** What `hostFacts` reads from the company's root: the installed `sanoma`, `origin` and the public sites' domains. */
export type HostRootFacts = Pick<HostFacts, "version" | "origin" | "domains">;

/**
 * The root's part of the hosts' facts (`HostRootFacts`), read now: the `sanoma` the repository
 * installs, `origin` (git, with no credentials) and the public sites' domains. Node only, where
 * the root is; a bundle carries them as read (the app's snapshot).
 */
export async function hostRootFacts(root: string): Promise<HostRootFacts> {
  const { siteDomains } = await import("./sites.ts");
  const [version, origin] = await Promise.all([installedSanoma(root), originUrl(root)]);
  return {
    ...(version !== undefined && { version }),
    ...(origin !== undefined && { origin }),
    domains: siteDomains(root),
  };
}

/**
 * What the declared hosts that derive (`deriveHosts`) are filled from: the root's facts
 * (`rootFacts`, asked only when a declared host derives: `hostRootFacts`, or a snapshot's), and of
 * `secrets` (none outside a run) which
 * optional credentials, App keys and source key are stored, which credentials the drivers
 * read from this machine's environment alone (`unbound`), and which bindings given to the hosts
 * (`host: true`) have no value (`hostEnvironmentUnset`). With `mint` (apply, never drift or a
 * sandbox run), the source key (where the config has the deploy-key type) and, when a wakeup is
 * declared, the wakeup's token are minted first when none is stored, so the host is given them
 * from its first apply. With no deploy-key type, GitHub is asked which repositories a host may clone are private.
 * Undefined when no declared host derives.
 */
export async function hostFacts(options: {
  rootFacts: () => Promise<HostRootFacts>;
  resources: readonly DeclaredResource[];
  types: ReadonlyMap<string, Resource>;
  drivers: ReadonlyMap<string, Driver>;
  secrets?: Secrets;
  builtInStore: boolean;
  /** The config's secret bindings: whether it binds `SANOMA_SIGNING_KEY`, and those given to the hosts (`host: true`). */
  bindings?: SecretConfiguration["bindings"];
  sender?: string;
  mint: boolean;
  /** A sandbox run's: its calls resolve no stored value, so a binding given to the hosts with none is no problem. */
  sandbox?: boolean;
}): Promise<HostFacts | undefined> {
  const { rootFacts, resources, types, drivers, secrets, mint } = options;
  const typeOf = (r: DeclaredResource) => types.get(`${r.vendor}.${r.type}`);
  const deriving = resources.filter((r) => typeOf(r)?.host?.derives);
  if (!deriving.length) return undefined;
  const hosts = deriving.filter((r) => !typeOf(r)?.host?.bindsBootstrap);
  // The store is read only in a run, and only for a host given secrets.
  const reading = secrets !== undefined && hosts.length > 0;
  // Which optional credentials and App keys are stored: read at once.
  const stored = async (names: readonly string[]) =>
    reading
      ? new Set((await Promise.all(names.map(async (n) => ((await secrets.get(n)) === undefined ? [] : [n])))).flat())
      : new Set<string>();
  const statuses = [...drivers].flatMap(([vendor, { env }]) =>
    env ? statusesOf(env, () => undefined).map((c) => ({ vendor, ...c })) : [],
  );
  const bindings = options.bindings ?? {};
  const hostEnvironment: Record<string, string> = Object.fromEntries(
    Object.entries(bindings).flatMap(([name, b]) => (b.host && b.env !== undefined ? [[b.env, name]] : [])),
  );
  const delivered = Object.values(hostEnvironment);
  // Only what the store holds: a marker for a name it does not would fail the host's deploy.
  const held = await stored([...statuses.map((c) => c.name), ...delivered]);
  const hostEnvironmentUnset = reading && !options.sandbox ? delivered.filter((name) => !held.has(name)) : [];
  const carried = new Map<string, string[]>();
  const unbound = new Map<string, string[]>();
  for (const c of statuses) {
    // The driver reads the environment first: set there alone, it runs here and the host is not given it.
    const into = held.has(c.name) ? carried : reading && process.env[c.name] ? unbound : undefined;
    into?.set(c.vendor, [...(into.get(c.vendor) ?? []), c.name]);
  }
  const githubApp = [...(await stored(Object.values(GITHUB_APP)))];
  if (mint && secrets && hosts.some((h) => wokenBy(h, resources, types))) await mintWakeupToken(secrets);
  const keyed = types.has(DEPLOY_KEY_TYPE);
  const [{ version, origin, domains }, sourceKey] = await Promise.all([
    rootFacts(),
    reading && keyed ? sourceKeyOf(secrets, mint) : undefined,
  ]);
  // What a host may clone: `origin`, else the `source` it declares (with no deploy-key type, no
  // GitHub repository is declared to be one).
  const repositories = keyed
    ? []
    : [
        ...new Set(
          [
            githubRepository(origin),
            ...hosts.map((h) => githubRepository(valueAt(h.desired, typeOf(h)!.host!.inputs.source))),
          ].filter((r) => r !== undefined),
        ),
      ];
  const open = await Promise.all(repositories.map(publicOnGithub));
  const privateRepositories = repositories.filter((_, i) => open[i] === false);
  return {
    ...(version !== undefined && { version }),
    ...(origin !== undefined && { origin }),
    domains,
    builtInStore: options.builtInStore,
    carried,
    ...(unbound.size > 0 && { unbound }),
    ...(bindings.SANOMA_SIGNING_KEY !== undefined && { signingKeyBound: true }),
    ...(delivered.length > 0 && { hostEnvironment }),
    ...(hostEnvironmentUnset.length > 0 && { hostEnvironmentUnset }),
    ...(options.sender !== undefined && { sender: options.sender }),
    githubApp,
    ...(sourceKey !== undefined && { sourceKey }),
    ...(privateRepositories.length > 0 && { privateRepositories }),
  };
}
