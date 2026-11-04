import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { databaseUrlSecret } from "./database.ts";
import { statusesOf } from "./env.ts";
import type { Driver } from "./op.ts";
import type { DeclaredResource, ResourceProblem } from "./description.ts";
import { runtimeImage } from "./host.ts";
import type { Bindings } from "./lockfile.ts";
import { type Resource, valueAt } from "./resource.ts";
import { secret, type Secret, type Secrets } from "./secret.ts";
import { sourceKeyPair, sshPublicKey } from "./ssh-key.ts";
import { mintInstanceToken, WAKEUP_TOKEN } from "./wakeup-service.ts";

// What a host that derives (`HostSpec.derives`) is given beyond its decisions: a data file says
// where it runs, its name, its hostname and the database it runs on, and apply fills the rest
// before it plans, as it fills a host's revision. Nothing here is ever a secret's value: the
// secrets a host is given are markers (`secret("NAME")`), resolved by its driver just before the
// vendor call, so a declaration, a plan, a ledger entry or a page holds names only.

/** The private half of the key a host clones a private GitHub repository with: minted at its first apply, held in the store. */
export const SOURCE_KEY = "SANOMA_SOURCE_KEY";

/** Where the company's GitHub App's keys are stored by the app's Connect page, which a host carries when they are. */
export const GITHUB_APP_SECRETS = [
  "SANOMA_GITHUB_APP_ID",
  "SANOMA_GITHUB_APP_SLUG",
  "SANOMA_GITHUB_CLIENT_ID",
  "SANOMA_GITHUB_CLIENT_SECRET",
  "SANOMA_GITHUB_WEBHOOK_SECRET",
  "SANOMA_GITHUB_APP_PEM",
] as const;

/** The wakeup service's URL, which a host is given beside its token when `sanoma.wakeup` wakes it. */
const WAKEUP_URL = "SANOMA_WAKEUP_URL";

/** The type of the key that lets a host clone its GitHub repository, which apply declares on it. */
export const DEPLOY_KEY_TYPE = "github.repository_deploy_key";

/** The title a host's deploy key has on GitHub. */
export const DEPLOY_KEY_TITLE = "Sanoma host";

/** The id apply gives the deploy key it declares for the host `hostId`: `resources/sanoma/infra.ts#host.sourceKey`. */
export const sourceKeyId = (hostId: string) => `${hostId}.sourceKey`;

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
   * people in through (the login's sender), by vendor: the variables the vendor's driver reads,
   * an optional one only when it is stored.
   */
  carried: ReadonlyMap<string, readonly string[]>;
  /** The login sender's vendor, whose credentials a host carries so it sends sign-in codes. */
  sender?: string;
  /** The company's GitHub App's keys that are stored (`GITHUB_APP_SECRETS`), which a host carries for sign-in and webhooks. */
  githubApp: readonly string[];
  /** The public half of the stored `SANOMA_SOURCE_KEY`, when one is: what apply declares on the repository. */
  sourceKey?: string;
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

/** Sets `value` at the dotted `path` of `into`, making the objects on the way. */
function setAt(into: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let at = into;
  for (const key of keys.slice(0, -1)) at = (at[key] ??= {}) as Record<string, unknown>;
  at[keys.at(-1)!] = value;
}

/** A declaration's export: `host` of `resources/sanoma/infra.ts#host`. */
const exportOf = (id: string) => id.slice(id.indexOf("#") + 1);

/**
 * Fills, in place, each declared host that derives (`HostSpec.derives`) with what it is not told,
 * and puts the deploy key it clones with before it in `resources`:
 *
 * - `image`, left out: the runtime image of the installed `sanoma` (`runtimeImage`);
 * - `source`, left out: the one repository its own data file declares (a reference to it, of a
 *   type its `source` names), else the repository the app runs from (`origin`);
 * - `domains`: each public site's domain (`siteDomains`);
 * - `secrets` (unless it binds its own bootstrap), markers only: the declared `database`'s URL as
 *   `SANOMA_DATABASE_URL`, the runtime's keys (the signing key, and the encryption key with the
 *   built-in store), the source key for a GitHub repository, the wakeup's token (and URL, for
 *   `sanoma.wakeup`) when a wakeup names it, the credentials of its own vendor, its repository's
 *   and the login sender's, and the company's GitHub App's keys that are stored;
 * - for a GitHub repository, a `github.repository_deploy_key` (`sourceKeyId`), read-only, whose
 *   key is the stored source key's public half, when one is and the config has the type.
 *
 * `ref` is resolved by apply (and drift) with the revision: the repository's default branch.
 * Problems: a host with no `database`, an image or a source that cannot be told.
 */
export function deriveHosts(
  resources: DeclaredResource[],
  types: ReadonlyMap<string, Resource>,
  bindings: Bindings,
  facts: HostFacts,
): ResourceProblem[] {
  const problems: ResourceProblem[] = [];
  // A copy: the deploy keys are put in `resources` as it goes.
  for (const r of resources.slice()) {
    const type = types.get(`${r.vendor}.${r.type}`);
    if (!type?.host?.derives) continue;
    const spec = type.host;
    const { inputs } = spec;
    const problem = (message: string) => problems.push({ ...r.at, message: `${r.at.export}: ${message}` });
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

    if (inputs.domains !== undefined && Object.keys(facts.domains).length) {
      setAt(desired, inputs.domains, { ...facts.domains });
    }

    if (spec.bindsBootstrap || inputs.secrets === undefined) continue;
    const secrets: Record<string, Secret> = {};
    const database = inputs.database === undefined ? undefined : refs[inputs.database];
    if (database) secrets.SANOMA_DATABASE_URL = secret(databaseUrlSecret(exportOf(database)));
    else problem("declare the database it runs on, `database: store`: the host is given its URL");
    secrets.SANOMA_SIGNING_KEY = secret("SANOMA_SIGNING_KEY");
    if (facts.builtInStore) secrets.SANOMA_SECRETS_KEY = secret("SANOMA_SECRETS_KEY");
    if (repository) secrets[SOURCE_KEY] = secret(SOURCE_KEY);
    for (const other of resources) {
      const wakeup = types.get(`${other.vendor}.${other.type}`)?.wakeup;
      if (!wakeup || other.refs[wakeup.inputs.host] !== r.id) continue;
      secrets[WAKEUP_TOKEN] = secret(WAKEUP_TOKEN);
      if (other.vendor === "sanoma") secrets[WAKEUP_URL] = secret(WAKEUP_URL);
    }
    // What it deploys itself with after a push: the vendors of its data file, its repository's, the sender's.
    const vendors = new Set([
      ...resources.filter((o) => o.file === r.file).map((o) => o.vendor),
      ...(repository ? ["github"] : []),
      ...(facts.sender ? [facts.sender] : []),
    ]);
    const carried = [...vendors].flatMap((vendor) => facts.carried.get(vendor) ?? []);
    for (const name of [...carried, ...facts.githubApp]) secrets[name] = secret(name);
    setAt(desired, inputs.secrets, secrets);

    if (repository && facts.sourceKey && types.has(DEPLOY_KEY_TYPE)) {
      const id = sourceKeyId(r.id);
      const binding = bindings[id]?.id;
      resources.splice(resources.indexOf(r), 0, {
        id,
        file: r.file,
        vendor: "github",
        type: "repository_deploy_key",
        name: exportOf(id),
        ...(binding !== undefined && { binding }),
        at: { file: r.at.file, export: exportOf(id) },
        desired: { repository, title: DEPLOY_KEY_TITLE, key: facts.sourceKey, read_only: true },
        refs: repositoryId ? { repository: repositoryId } : {},
      });
    }
  }
  return problems;
}

/**
 * What the declared hosts that derive (`deriveHosts`) are filled from, read now: the installed
 * `sanoma`, `origin`, the public sites' domains, and of `secrets` (none outside a run) which
 * optional credentials, App keys and source key are stored. With `mint` (apply, never drift or a
 * sandbox run), the source key and, when a wakeup is declared, the wakeup's token are minted
 * first when none is stored, so the host is given them from its first apply. Undefined when no
 * declared host derives.
 */
export async function hostFacts(options: {
  root: string;
  resources: readonly DeclaredResource[];
  types: ReadonlyMap<string, Resource>;
  drivers: ReadonlyMap<string, Driver>;
  secrets?: Secrets;
  builtInStore: boolean;
  sender?: string;
  mint: boolean;
}): Promise<HostFacts | undefined> {
  const { root, resources, types, drivers, secrets, mint } = options;
  const typeOf = (r: DeclaredResource) => types.get(`${r.vendor}.${r.type}`);
  const hosts = resources.filter((r) => typeOf(r)?.host?.derives && !typeOf(r)?.host?.bindsBootstrap);
  if (!resources.some((r) => typeOf(r)?.host?.derives)) return undefined;
  const stored = async (name: string) => (await secrets?.get(name)) !== undefined;
  const carried = new Map<string, string[]>();
  for (const [vendor, { env }] of drivers) {
    if (!env) continue;
    const names: string[] = [];
    for (const c of statusesOf(env, () => undefined)) if (!c.optional || (await stored(c.name))) names.push(c.name);
    carried.set(vendor, names);
  }
  const githubApp: string[] = [];
  for (const name of GITHUB_APP_SECRETS) if (await stored(name)) githubApp.push(name);
  const woken = (host: DeclaredResource) =>
    resources.some((o) => {
      const wakeup = typeOf(o)?.wakeup;
      return wakeup !== undefined && o.refs[wakeup.inputs.host] === host.id;
    });
  if (mint && secrets && hosts.some(woken)) await mintWakeupToken(secrets);
  const { siteDomains } = await import("./sites.ts");
  const [version, origin, sourceKey] = await Promise.all([
    installedSanoma(root),
    originUrl(root),
    secrets && hosts.length ? sourceKeyOf(secrets, mint) : undefined,
  ]);
  return {
    ...(version !== undefined && { version }),
    ...(origin !== undefined && { origin }),
    domains: siteDomains(root),
    builtInStore: options.builtInStore,
    carried,
    ...(options.sender !== undefined && { sender: options.sender }),
    githubApp,
    ...(sourceKey !== undefined && { sourceKey }),
  };
}
