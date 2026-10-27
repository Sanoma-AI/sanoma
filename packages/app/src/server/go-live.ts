// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createPublicKey, generateKeyPair } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  APPLY_WORKFLOW,
  databaseUrlSecret,
  errorMessage,
  isEnded,
  type Principal,
  type RepoRef,
  type Resource,
  vendorCodeOf,
  wakeupHostTypes,
} from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, readLockfile, Reference, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import {
  ApiError,
  INFRA,
  type GoLiveChoices,
  type GoLiveProgress,
  type GoLiveRequest,
  type GoLiveRun,
  SETUP_VENDORS,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { asApplyPlan } from "../lib/apply-plan.ts";
import { invalid } from "./core.ts";
import { secretValues } from "./secrets.ts";
import { mintWakeupToken, WAKEUP_URL } from "./setup.ts";

// Going live, steps 2 to 6 (step 1 is connect, in setup.ts): choose where the company goes,
// write `resources/sanoma/infra.ts`, apply the repository, the deploy key the host clones it with
// and the database, push the local repository to the new one, apply the host, and wait until it
// answers. Every change to a vendor is the built-in apply workflow's; what this file calls itself
// is only reading lists of accounts to choose from, and git. The database, the host and the
// wakeup are chosen by their contracts (`database`, `host`, `wakeup`) among the config's resource
// types, never named but to prefer one.

/** What `infra.ts` declares, by export: the lockfile's keys. */
const KEYS = {
  repo: `${INFRA}#repo`,
  deployKey: `${INFRA}#deployKey`,
  store: `${INFRA}#store`,
  host: `${INFRA}#host`,
  wakeup: `${INFRA}#wakeup`,
} as const;

/** The repository type going live declares. */
const REPOSITORY = "github.repository";

/** The database type going live prefers when the config has it: Neon's, which pauses. */
const NEON = "neon.project";
/** Supabase's project, the database type that takes an organization (`DATABASE_EXTRAS`). */
const SUPABASE = "supabase.project";
/** The host type going live prefers once Cloudflare is connected, then a container on this machine. */
const CLOUDFLARE = "cloudflare.container";
const DOCKER = "docker.container";

/** The runtime image a container on this machine runs: `docker build -t sanoma-runtime packages/sanoma/runtime`. */
export const RUNTIME_IMAGE = "sanoma-runtime";
/**
 * The runtime image every other host runs, tagged with the version of `sanoma` the company
 * installs: GitHub's registry, which Cloudflare's container copies into its account at apply.
 */
const PUBLISHED_IMAGE = "ghcr.io/sanoma-ai/runtime";

/** The secret the database's URL is stored in: its `storeUrl` for the export `store`. */
const DATABASE_URL = databaseUrlSecret("store");
const SECRETS_KEY = "SANOMA_SECRETS_KEY";
/**
 * The private half of the repository's read-only deploy key, which the host clones the private
 * repository with at every start (the runtime image's entrypoint): stored, given to the host
 * among its secrets, never in a data file. Its public half is the `deployKey` going live declares.
 */
const SOURCE_KEY = "SANOMA_SOURCE_KEY";

/**
 * What going live fills in a database type beyond its contract's inputs, by type, from the
 * choices: Supabase's organization, and the password apply generates (the one its `storeUrl`
 * reads). A per-type extra rather than a rule on field names, until a second type needs one.
 */
const DATABASE_EXTRAS: Record<string, (choices: { organization?: string }) => Record<string, DataValue>> = {
  [SUPABASE]: ({ organization }) => {
    if (!organization) invalid("organization", "Choose a Supabase organization");
    return {
      organization_id: organization,
      database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
    };
  },
};

const GITHUB_API = "https://api.github.com";
/** The wakeup's declaration in `infra.ts`, as `renderInfra` writes it. */
const WAKEUP_LINE = /^export const wakeup = /m;
/** The repository's name in `infra.ts` as `renderInfra` writes it. */
const REPO_NAME = /export const repo = github\.repository\(\{\s*name: "([^"]+)"/;
const SUPABASE_API = "https://api.supabase.com";

const idOf = (type: Resource) => `${type.vendor}.${type.type}`;
const hasField = (type: Resource, field: string) => field in (type.schema.shape as Record<string, unknown>);

/** What going live declares that the config's connectors do not: the repository type, a database type, a host type. */
const missingTypes = ({ resolved }: AppContext) => {
  const types = [...resolved.types.values()];
  return [
    ...(resolved.types.has(REPOSITORY) ? [] : [REPOSITORY]),
    ...(types.some((type) => type.database) ? [] : ["a database type"]),
    ...(types.some((type) => type.host) ? [] : ["a host type"]),
  ];
};

/**
 * The secrets going live reads: GitHub's and Supabase's tokens (for the lists the page offers),
 * and those that say which vendors are connected (`SETUP_VENDORS`' tokens).
 */
const connections = ({ client }: AppContext) =>
  client.secrets([...new Set(["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN", ...SETUP_VENDORS.flatMap((v) => v.tokens)])]);
type Connections = Awaited<ReturnType<typeof connections>>;

/**
 * True when every token that connects `vendor` is stored; true for a vendor `/setup` does not
 * connect (Docker's, or one whose credentials its connector page holds), which it cannot tell,
 * unless `strictly`: then only a `/setup` vendor can be, for what going live may leave out (a wakeup).
 */
const isConnected = (stored: Connections, vendor: string, strictly = false) => {
  const setup = SETUP_VENDORS.find((v) => v.vendor === vendor);
  return setup ? setup.tokens.every((name) => stored.has(name)) : !strictly;
};

/**
 * Of the config's types that meet a contract, the first of `preferred` whose vendor is
 * connected, else the first connected; when none is, the same over all (the page asks to connect).
 */
function pick(app: AppContext, stored: Connections, meets: (type: Resource) => unknown, preferred: string[]) {
  const all = [...app.resolved.types.values()].filter(meets);
  const connected = all.filter((type) => isConnected(stored, type.vendor));
  const among = connected.length ? connected : all;
  return preferred.map((id) => among.find((type) => idOf(type) === id)).find(Boolean) ?? among[0];
}

/** The titles of the vendors to connect before going live: the chosen database's and host's, when not connected. */
const toConnect = ({ stored, database, host }: Awaited<ReturnType<typeof choose>>) =>
  [database, host].flatMap((type) =>
    type && !isConnected(stored, type.vendor) ? [SETUP_VENDORS.find((v) => v.vendor === type.vendor)!.title] : [],
  );

/**
 * What going live chooses now, from what is connected: the database (Neon's first), the host
 * (Cloudflare's first, then Docker's) and its wakeup.
 */
async function choose(app: AppContext) {
  const stored = await connections(app);
  const database = pick(app, stored, (type) => type.database, [NEON]);
  const host = pick(app, stored, (type) => type.host, [CLOUDFLARE, DOCKER]);
  return { stored, database, host, wakeup: host ? hostWakeup(app, host, stored) : {} };
}

/** `into`, with `value` at its dotted `path`, the objects on the way made. */
function setPath(into: Record<string, DataValue>, path: string, value: DataValue): Record<string, DataValue> {
  const keys = path.split(".");
  const last = keys.pop()!;
  let at = into;
  for (const key of keys) at = (at[key] ??= {}) as Record<string, DataValue>;
  at[last] = value;
  return into;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** `url`'s answer as JSON, or an error saying who answered what. */
async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} to ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "sanoma",
});

/** RFC 4253's `string`: the bytes after their length, 32 bits big-endian. */
function sshString(bytes: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** RFC 4253's `mpint` of a JWK's integer, unsigned with no leading zero: one first when its top bit is set. */
function sshMpint(value: string) {
  const bytes = Buffer.from(value, "base64url");
  return sshString(bytes[0]! & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes);
}

/**
 * A new deploy key: its private half RSA 3072 in PKCS#1 PEM, which OpenSSH reads as it is (Node
 * writes no OpenSSH private key, which ed25519 would need), and its public half in OpenSSH's
 * one-line format, as GitHub takes it: `ssh-rsa`, then the base64 of the strings `ssh-rsa`, `e`
 * and `n`.
 */
export async function sourceKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const { privateKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 3072 });
  const { e, n } = createPublicKey(privateKey).export({ format: "jwk" });
  const wire = Buffer.concat([sshString(Buffer.from("ssh-rsa")), sshMpint(e!), sshMpint(n!)]);
  return {
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: `ssh-rsa ${wire.toString("base64")}`,
  };
}

/**
 * The GitHub connector's remote half over the stored credentials alone: going live lists accounts
 * with the stored `GITHUB_TOKEN` (`connections`), so it pushes with that one too, not one this
 * process's environment happens to have.
 */
const githubOf = (app: AppContext) => ({
  remote: app.resolved.remotes.get("github"),
  context: { secrets: secretValues(app.client, { environment: false }) },
});

/**
 * What the page offers: the GitHub accounts the token (its user and organizations) and the App
 * (its installations) can make a repository in, the database type with its regions and the
 * Supabase organizations the token sees when it is Supabase's, and the host type. A list that
 * cannot be read is empty, and says why.
 */
export async function goLiveChoices(app: AppContext): Promise<GoLiveChoices> {
  const errors: string[] = [];
  const chosen = await choose(app);
  const { stored: tokens, database, host, wakeup } = chosen;
  const listed = async <T>(what: string, list: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await list();
    } catch (err) {
      errors.push(`${what}: ${errorMessage(err)}`);
      return [];
    }
  };
  const github = tokens.get("GITHUB_TOKEN")?.value;
  // Supabase's organizations, for a Supabase project's `organization_id` (`DATABASE_EXTRAS`).
  const organized = database !== undefined && idOf(database) === SUPABASE;
  const supabase = organized ? tokens.get("SUPABASE_ACCESS_TOKEN")?.value : undefined;
  const [user, orgs, installed, organizations] = await Promise.all([
    github
      ? listed("GitHub's user", async () => [
          await fetchJson<{ login: string }>(`${GITHUB_API}/user`, githubHeaders(github)),
        ])
      : [],
    github
      ? listed("GitHub's organizations", () =>
          fetchJson<{ login: string }[]>(`${GITHUB_API}/user/orgs`, githubHeaders(github)),
        )
      : [],
    // The accounts the GitHub App is installed on, from the GitHub connector's remote half.
    listed("The GitHub App's installations", async () => {
      const { remote, context } = githubOf(app);
      return (await remote?.owners?.(context)) ?? [];
    }),
    supabase
      ? listed("Supabase's organizations", () =>
          fetchJson<{ id: string; name: string }[]>(`${SUPABASE_API}/v1/organizations`, {
            authorization: `Bearer ${supabase}`,
          }),
        )
      : [],
  ]);
  const owners: GoLiveChoices["owners"] = [
    ...user.map(({ login }) => ({ login, kind: "user" as const, via: "token" as const })),
    ...orgs.map(({ login }) => ({ login, kind: "organization" as const, via: "token" as const })),
  ];
  for (const { login, kind } of installed) {
    if (!owners.some((o) => o.login === login)) owners.push({ login, kind, via: "app" });
  }
  if (wakeup.cannot) errors.push(wakeup.cannot);
  return {
    owners,
    organizations: organized ? organizations.map(({ id, name }) => ({ id, name })) : null,
    database: database
      ? {
          type: idOf(database),
          title: database.title,
          regions: database.database!.regions ?? null,
          size: database.database!.inputs.size !== undefined,
        }
      : null,
    host: host ? { type: idOf(host), title: host.title, publicUrl: host.host!.capabilities.publicUrl } : null,
    missing: missingTypes(app),
    connect: toConnect(chosen),
    name:
      app.description.appName
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 63) || "company",
    errors,
  };
}

/**
 * Whether going live declares a wakeup, the one rule the choices and `renderInfra` share: among
 * the config's wakeup types whose vendor `/setup` connected (`isConnected`, strictly), the one that wakes this
 * host's type (`wakeupHostTypes`), the host's own vendor's first. `type` is it, and `secrets` what
 * the host is given for it: the instance's token, which `goLive` mints first when none is stored,
 * and for `sanoma.wakeup` the service's `SANOMA_WAKEUP_URL`, where the worker registers. With connected wakeups but none for this host,
 * `cannot` says why, and none is declared. With none connected: no wakeup, and nothing to say.
 */
function hostWakeup(
  { resolved }: AppContext,
  host: Resource,
  stored: Connections,
): { type?: Resource; secrets?: Record<string, DataValue>; cannot?: string } {
  const connected = [...resolved.types.values()].filter(
    (type) => type.wakeup && isConnected(stored, type.vendor, true),
  );
  if (!connected.length) return {};
  const id = idOf(host);
  const own = (type: Resource) => (type.vendor === host.vendor ? 0 : 1);
  const type = connected.filter((t) => wakeupHostTypes(t).includes(id)).toSorted((a, b) => own(a) - own(b))[0];
  if (!type) {
    const wakes = connected.map((t) => `${t.title} (${idOf(t)}) wakes ${wakeupHostTypes(t).join(", ")}`);
    return {
      cannot: `No connected wakeup wakes a ${id} (${wakes.join("; ")}): going live declares none, and the host stays up`,
    };
  }
  const service = type.vendor === "sanoma";
  return {
    type,
    secrets: { [WAKEUP_TOKEN]: secret(WAKEUP_TOKEN), ...(service && { [WAKEUP_URL]: secret(WAKEUP_URL) }) },
  };
}

/**
 * The version of `sanoma` the company's repository installs (resolved from its root, so a
 * hoisted install counts), which the host's runtime image is tagged with.
 */
async function sanomaVersion(root: string): Promise<string> {
  const version = await Promise.resolve()
    .then(() => readFile(findPackageJSON("sanoma", join(root, "package.json"))!, "utf8"))
    .then((read) => (JSON.parse(read) as { version?: unknown }).version)
    .catch(() => undefined);
  if (typeof version !== "string") {
    throw new ApiError(409, { error: `sanoma is not installed in the company's repository (${root}): install it` });
  }
  return version;
}

/**
 * `infra.ts`'s text for the choices: the repository and its read-only deploy key (`deployKey`, the
 * public half of `SANOMA_SOURCE_KEY`, which the host is given to clone with), the database, the
 * host that runs the company from them and, once a wakeup for the host is connected, the wakeup
 * that starts the host again, whose instance token the host is given from the first apply
 * (`hostWakeup`).
 */
export async function renderInfra(
  app: AppContext,
  { name, organization, region, size, database: shownDatabase, host: shown, port }: Omit<GoLiveRequest, "owner">,
  deployKey: string,
  chosen?: Awaited<ReturnType<typeof choose>>,
) {
  const { database, host, wakeup } = chosen ?? (await choose(app));
  const vendors = app.description.vendors;
  const missing = missingTypes(app);
  if (missing.length || !host || !database) {
    throw new ApiError(409, {
      error: `The config's connectors declare no ${missing.join(", ")}: add them to sanoma.config.ts`,
    });
  }
  // What is connected changed since the page chose (Cloudflare or Supabase connected meanwhile, say).
  if (shown !== undefined && shown !== idOf(host)) {
    throw new ApiError(409, {
      error: `Going live now runs the company on ${idOf(host)}, not ${shown}: reload the page`,
    });
  }
  if (shownDatabase !== undefined && shownDatabase !== idOf(database)) {
    throw new ApiError(409, {
      error: `Going live now keeps the company's records in ${idOf(database)}, not ${shownDatabase}: reload the page`,
    });
  }
  const constructors = (vendor: string) => {
    // The runtime's own (`sanoma.wakeup`) is in no connector of the config's.
    const pkg = vendor === "sanoma" ? "sanoma" : vendors[vendor]?.package;
    if (!pkg) throw new ApiError(409, { error: `The ${vendor} connector names no package to import from` });
    return { source: `${pkg}/resources`, imported: vendor, local: vendor };
  };

  const { inputs: dbInputs, regions } = database.database!;
  if (regions && !regions.includes(region)) invalid("region", `${database.title} has no region ${region}`);
  if (size && !dbInputs.size) invalid("size", `${database.title} takes no size: reload the page`);
  const store: Record<string, DataValue> = { ...(hasField(database, "name") && { name }) };
  setPath(store, dbInputs.region, region);
  if (size) setPath(store, dbInputs.size!, size);
  Object.assign(store, DATABASE_EXTRAS[idOf(database)]?.({ ...(organization && { organization }) }));

  const { inputs } = host.host!;
  const hosted: Record<string, DataValue> = { ...(hasField(host, "name") && { name }) };
  if (hasField(host, "image")) {
    hosted.image =
      idOf(host) === DOCKER ? RUNTIME_IMAGE : `${PUBLISHED_IMAGE}:${await sanomaVersion(app.resolved.root!)}`;
  }
  setPath(hosted, inputs.source, new Reference("repo"));
  setPath(hosted, inputs.ref, "main");
  setPath(hosted, inputs.secrets, {
    SANOMA_DATABASE_URL: secret(DATABASE_URL),
    SANOMA_SECRETS_KEY: secret(SECRETS_KEY),
    [SOURCE_KEY]: secret(SOURCE_KEY),
    ...wakeup.secrets,
  });
  setPath(hosted, inputs.port, port);
  const woken = wakeup.type;
  return renderDataFile(
    {
      imports: [...new Set(["github", database.vendor, host.vendor, ...(woken ? [woken.vendor] : [])])].map(
        constructors,
      ),
      exports: [
        { name: "repo", vendor: "github", type: "repository", desired: { name, visibility: "private" } },
        {
          name: "deployKey",
          vendor: "github",
          type: "repository_deploy_key",
          desired: {
            repository: new Reference("repo"),
            title: "Sanoma host",
            key: deployKey,
            read_only: true,
          },
        },
        { name: "store", vendor: database.vendor, type: database.type, desired: store },
        { name: "host", vendor: host.vendor, type: host.type, desired: hosted },
        ...(woken
          ? [
              {
                name: "wakeup",
                vendor: woken.vendor,
                type: woken.type,
                desired: setPath({}, woken.wakeup!.inputs.host, new Reference("host")),
              },
            ]
          : []),
      ],
    },
    formatOptions(app.resolved.root!),
  );
}

/**
 * Step 3 and 4: writes `infra.ts` for the choices with a new deploy key, whose private half it
 * stores as `SANOMA_SOURCE_KEY`, and commits it, stores the owner as the GitHub connector's
 * `GITHUB_OWNER`, and starts apply on the repository, its deploy key and the database. Apply
 * creates them, binds them in the lockfile and, once the project is healthy, stores its database
 * URL (its `afterCreate`). Refused once the file is written: going live writes it once.
 */
export async function goLive(app: AppContext, actor: Principal, choices: GoLiveRequest): Promise<{ runId: string }> {
  const { client, resolved, source } = app;
  if (resolved.root === undefined) throw new Error("The config has no root, so its data files cannot be written");
  const path = join(resolved.root, INFRA);
  if (await exists(path)) {
    throw new ApiError(409, { error: `${INFRA} is written already: change it in the file, and apply from Resources` });
  }
  // `SANOMA_SECRETS_KEY` is the host's from this process's environment, where the launcher's
  // `.env` sets it, and where the secrets store reads it first: there is nothing to store.
  if (!process.env[SECRETS_KEY]) throw new ApiError(409, { error: `${SECRETS_KEY} is not set` });
  // The GitHub connector makes the repository with a token of the person's own: an App's
  // installation alone cannot yet.
  const chosen = await choose(app);
  if (!chosen.stored.has("GITHUB_TOKEN")) {
    throw new ApiError(409, {
      error: "The GitHub connector creates the repository with GITHUB_TOKEN: connect a token",
    });
  }
  // The database's and the host's vendors connected: their tokens are what apply makes them with.
  const connect = toConnect(chosen);
  if (connect.length) throw new ApiError(409, { error: `Connect ${connect.join(" and ")} first` });
  // A new key each time: GitHub takes a key for one repository only, and none declares this one yet.
  const key = await sourceKeyPair();
  const text = await renderInfra(app, choices, key.publicKey, chosen);
  await client.setSecret(SOURCE_KEY, key.privateKey, { by: actor.id });
  // Once the request is good: a wakeup's token may be the environment's or its connector page's, which mint nothing.
  if (chosen.wakeup.type) await mintWakeupToken(client, actor);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await source?.commit({
    paths: [INFRA],
    message: "Go live: declare the repository, its deploy key, the database and the host",
    author: actor.id,
  });
  await client.setSecret("GITHUB_OWNER", choices.owner, { by: actor.id });
  const runId = await client.apply({ only: [KEYS.repo, KEYS.deployKey, KEYS.store] }, { startedBy: actor });
  return { runId };
}

/**
 * The token a push to `repo` signs in with, from the GitHub connector's remote half: the stored
 * `GITHUB_TOKEN`, else an installation token of the GitHub App installed on the owner.
 */
async function pushToken(app: AppContext, repo: RepoRef): Promise<string> {
  const { remote, context } = githubOf(app);
  if (!remote)
    throw new ApiError(409, {
      error: "The GitHub connector has no remote half: install @sanoma-ai/connector-github of this release",
    });
  try {
    return await remote.open(repo, context).token("token");
  } catch (err) {
    // Neither a token nor the App: something to connect, not GitHub failing.
    if (vendorCodeOf(err) === "no_token") throw new ApiError(409, { error: errorMessage(err) });
    throw err;
  }
}

/**
 * Steps 5 and 6: pushes the local repository's `main`, with `infra.ts` and the lockfile on top,
 * to the repository apply made, then starts apply on the host (and its wakeup, when declared).
 * Refused until the repository, its deploy key (which the host clones with) and the database are
 * bound.
 */
export async function goLiveHost(app: AppContext, actor: Principal): Promise<{ runId: string }> {
  const { client, resolved, source } = app;
  const { bindings } = readLockfile(resolved.root!);
  if (!bindings[KEYS.repo] || !bindings[KEYS.deployKey] || !bindings[KEYS.store]) {
    throw new ApiError(409, { error: "Apply the repository, its deploy key and the database first" });
  }
  if (!source?.push) throw new ApiError(409, { error: "The app has no repository to push from" });
  // The database's `afterCreate` stores it (its `storeUrl`); one bound without it (a hook that failed) cannot run a host.
  if (!(await client.secrets([DATABASE_URL])).has(DATABASE_URL)) {
    throw new ApiError(409, {
      error: `${DATABASE_URL} is not stored: the database's URL was not stored after its create`,
    });
  }
  // What is pushed is `main`, where going live committed: refused on another branch.
  if ((await source.head()) !== (await Promise.resolve(source.head("main")).catch(() => undefined))) {
    throw new ApiError(409, { error: "Check out main, where infra.ts and the lockfile are committed, then push" });
  }
  const owner = (await client.secrets(["GITHUB_OWNER"])).get("GITHUB_OWNER")?.value;
  const infra = await readFile(join(resolved.root!, INFRA), "utf8");
  // The repository's name as going live wrote it, first in the file.
  const name = REPO_NAME.exec(infra)?.[1];
  if (!owner || !name) throw new ApiError(409, { error: `Cannot tell the repository from ${INFRA} and GITHUB_OWNER` });
  try {
    await source.push({
      url: `https://github.com/${owner}/${name}.git`,
      token: await pushToken(app, { owner, name }),
      ref: "main",
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, { error: errorMessage(err) });
  }
  // The wakeup, when declared, after the host it names: one apply, in dependency order.
  const only = WAKEUP_LINE.test(infra) ? [KEYS.host, KEYS.wakeup] : [KEYS.host];
  const runId = await client.apply({ only }, { startedBy: actor });
  return { runId };
}

/** The latest apply run, as the page follows it. */
async function latestRun({ client }: AppContext): Promise<GoLiveRun | null> {
  const [run] = await client.runs({ workflow: APPLY_WORKFLOW, limit: 1 });
  if (!run) return null;
  const pending = run.approvals.find((a) => a.status === "pending");
  const plan = pending && asApplyPlan(pending.details);
  const report = run.status === "finished" ? await client.applyReport(run.runId) : undefined;
  return {
    runId: run.runId,
    status: run.status,
    ...(pending && { pending: { approvalId: pending.id, ...(plan && { plan }) } }),
    ...(report && { results: report.results }),
    ...(run.error && { error: run.error }),
  };
}

/** Where the host answers, from the latest finished apply runs that made or changed it, and whether `/healthz` answers. */
async function hostAnswer({ client }: AppContext): Promise<GoLiveProgress["host"]> {
  const runs = await client.runs({ workflow: APPLY_WORKFLOW, status: "finished", limit: 10 });
  const reports = await Promise.all(runs.map((run) => client.applyReport(run.runId)));
  for (const report of reports) {
    const result = report.results.find((r) => r.id === KEYS.host && r.host);
    if (result?.host) {
      const { url, healthy } = result.host;
      const answers = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(2_000) })
        .then((res) => res.ok)
        .catch(() => false);
      return { url, healthy: healthy && answers };
    }
  }
  return null;
}

/** How far going live is: `infra.ts`, the lockfile's bindings, the latest apply run and the host. */
export async function goLiveProgress(app: AppContext): Promise<GoLiveProgress> {
  const root = app.resolved.root;
  const infra = root === undefined ? null : await readFile(join(root, INFRA), "utf8").catch(() => null);
  const bindings = root === undefined ? {} : readLockfile(root).bindings;
  const bound = { repo: !!bindings[KEYS.repo], store: !!bindings[KEYS.store], host: !!bindings[KEYS.host] };
  const run = await latestRun(app);
  return { infra, bound, run, host: bound.host && run && isEnded(run.status) ? await hostAnswer(app) : null };
}
