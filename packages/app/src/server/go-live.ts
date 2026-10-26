// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createSign } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APPLY_WORKFLOW,
  errorMessage,
  isEnded,
  type Principal,
  type Resource,
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
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { asApplyPlan } from "../lib/apply-plan.ts";
import { CONNECTED_BY, GITHUB_APP, mintWakeupToken, OPS_URL } from "./setup.ts";

// Going live, steps 2 to 6 (step 1 is connect, in setup.ts): choose where the company goes,
// write `resources/sanoma/infra.ts`, apply the repository and the database, push the local
// repository to the new one, apply the host, and wait until it answers. Every change to a vendor
// is the built-in apply workflow's; what this file calls itself is only reading lists of accounts
// to choose from, and git. The database, the host and the wakeup are chosen by their contracts
// (`database`, `host`, `wakeup`) among the config's resource types, never named but to prefer one.

/** What `infra.ts` declares, by export: the lockfile's keys. */
const KEYS = {
  repo: `${INFRA}#repo`,
  store: `${INFRA}#store`,
  host: `${INFRA}#host`,
  wakeup: `${INFRA}#wakeup`,
} as const;

/** The repository type going live declares. */
const REPOSITORY = "github.repository";

/** The database type going live prefers when the config has it: Neon's, which pauses. */
const NEON = "neon.project";
/** The host type going live prefers once Cloudflare is connected, then a container on this machine. */
const CLOUDFLARE = "cloudflare.container";
const DOCKER = "docker.container";

/** The runtime image a container on this machine runs: `docker build -t sanoma-runtime packages/sanoma/runtime`. */
export const RUNTIME_IMAGE = "sanoma-runtime";
/** The runtime image every other host runs, tagged with the version of `sanoma` the company installs. */
export const PUBLISHED_IMAGE = "docker.io/sanomaai/runtime";

/** The secret the database's URL is stored in: its `storeUrl` for the export `store`. */
const DATABASE_URL = "SANOMA_DATABASE_URL_STORE";
const SECRETS_KEY = "SANOMA_SECRETS_KEY";

/**
 * What going live fills in a database type beyond its contract's inputs, by type, from the
 * choices: Supabase's organization, and the password apply generates (the one its `storeUrl`
 * reads). A per-type extra rather than a rule on field names, until a second type needs one.
 */
const DATABASE_EXTRAS: Record<string, (choices: { organization?: string }) => Record<string, DataValue>> = {
  "supabase.project": ({ organization }) => {
    if (!organization) {
      const error = "Choose a Supabase organization";
      throw new ApiError(400, {
        error,
        code: "invalid_input",
        issues: [{ path: ["organization"], message: error, code: "custom" }],
      });
    }
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

/** The config's database type: Neon's when it has it, else the first that meets the contract. */
function databaseType({ resolved }: AppContext): Resource | undefined {
  const neon = resolved.types.get(NEON);
  return neon?.database ? neon : [...resolved.types.values()].find((type) => type.database);
}

/** The secrets that say which vendors are connected (`CONNECTED_BY`), and the wakeup service's URL. */
const connections = ({ client }: AppContext) => client.secrets([...Object.values(CONNECTED_BY), OPS_URL]);
type Connections = Awaited<ReturnType<typeof connections>>;

const isConnected = (stored: Connections, vendor: string) => {
  const token = CONNECTED_BY[vendor];
  return token !== undefined && stored.has(token);
};

/** The config's host type: Cloudflare's once it is connected, else Docker's, else the first. */
function hostType({ resolved }: AppContext, stored: Connections): Resource | undefined {
  const hosts = [...resolved.types.values()].filter((type) => type.host);
  const named = (id: string) => hosts.find((type) => idOf(type) === id);
  const cloudflare = named(CLOUDFLARE);
  return (cloudflare && isConnected(stored, cloudflare.vendor) ? cloudflare : undefined) ?? named(DOCKER) ?? hosts[0];
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** `url`'s answer as JSON, or an error saying who answered what. */
async function fetchJson<T>(url: string, headers: Record<string, string>, method = "GET"): Promise<T> {
  const res = await fetch(url, { method, headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} to ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "sanoma",
});

const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT the GitHub App signs for itself, good for 9 minutes: what its installations are listed with. */
function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem, "base64url")}`;
}

type Installation = { id: number; account: { login: string; type: string } };

/** The GitHub App's installations, when its keys are stored. */
async function installations({ client }: AppContext): Promise<Installation[]> {
  const found = await client.secrets([GITHUB_APP.id, GITHUB_APP.pem]);
  const id = found.get(GITHUB_APP.id)?.value;
  const pem = found.get(GITHUB_APP.pem)?.value;
  if (!id || !pem) return [];
  return fetchJson<Installation[]>(`${GITHUB_API}/app/installations`, githubHeaders(appJwt(id, pem)));
}

/**
 * What the page offers: the GitHub accounts the token (its user and organizations) and the App
 * (its installations) can make a repository in, the database type with its regions and the
 * Supabase organizations the token sees when it is Supabase's, and the host type. A list that
 * cannot be read is empty, and says why.
 */
export async function goLiveChoices(app: AppContext): Promise<GoLiveChoices> {
  const errors: string[] = [];
  const tokens = await app.client.secrets(["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN"]);
  const listed = async <T>(what: string, list: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await list();
    } catch (err) {
      errors.push(`${what}: ${errorMessage(err)}`);
      return [];
    }
  };
  const github = tokens.get("GITHUB_TOKEN")?.value;
  const database = databaseType(app);
  // Supabase's organizations, for a Supabase project's `organization_id` (`DATABASE_EXTRAS`).
  const organized = database !== undefined && idOf(database) === "supabase.project";
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
    listed("The GitHub App's installations", () => installations(app)),
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
  for (const { account } of installed) {
    if (!owners.some((o) => o.login === account.login)) {
      owners.push({
        login: account.login,
        kind: account.type === "Organization" ? "organization" : "user",
        via: "app",
      });
    }
  }
  const stored = await connections(app);
  const host = hostType(app, stored);
  const cannot = host && hostWakeup(app, host, stored).cannot;
  if (cannot) errors.push(cannot);
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
 * the config's wakeup types whose vendor is connected (`CONNECTED_BY`), the one that wakes this
 * host's type (`wakeupHostTypes`), the host's own vendor's first. `type` is it, and `secrets` what
 * the host is given for it: the instance's token, which `goLive` mints first when none is stored,
 * and sanoma-ops's `SANOMA_OPS_URL` when one is. With connected wakeups but none for this host,
 * `cannot` says why, and none is declared. With none connected: no wakeup, and nothing to say.
 */
function hostWakeup(
  { resolved }: AppContext,
  host: Resource,
  stored: Connections,
): { type?: Resource; secrets?: Record<string, DataValue>; cannot?: string } {
  const connected = [...resolved.types.values()].filter((type) => type.wakeup && isConnected(stored, type.vendor));
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
  const opsUrl = type.vendor === "sanomaOps" && stored.has(OPS_URL);
  return { type, secrets: { [WAKEUP_TOKEN]: secret(WAKEUP_TOKEN), ...(opsUrl && { [OPS_URL]: secret(OPS_URL) }) } };
}

/** The version of `sanoma` the company's repository installs, which the host's runtime image is tagged with. */
async function sanomaVersion(root: string): Promise<string> {
  const manifest = join(root, "node_modules", "sanoma", "package.json");
  const read = await readFile(manifest, "utf8").catch(() => undefined);
  const version = read && (JSON.parse(read) as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new ApiError(409, { error: `sanoma is not installed in the company's repository (${manifest}): install it` });
  }
  return version;
}

/**
 * `infra.ts`'s text for the choices: the repository, the database, the host that runs the company
 * from them and, once a wakeup for the host is connected, the wakeup that starts the host again,
 * whose instance token the host is given from the first apply (`hostWakeup`).
 */
export async function renderInfra(
  app: AppContext,
  { name, organization, region, size, port }: Omit<GoLiveRequest, "owner">,
) {
  const database = databaseType(app);
  const stored = await connections(app);
  const host = hostType(app, stored);
  const vendors = app.description.vendors;
  const missing = missingTypes(app);
  if (missing.length || !host || !database) {
    throw new ApiError(409, {
      error: `The config's connectors declare no ${missing.join(", ")}: add them to sanoma.config.ts`,
    });
  }
  const constructors = (vendor: string) => {
    const pkg = vendors[vendor]?.package;
    if (!pkg) throw new ApiError(409, { error: `The ${vendor} connector names no package to import from` });
    return { source: `${pkg}/resources`, imported: vendor, local: vendor };
  };
  const wakeup = hostWakeup(app, host, stored);

  const dbInputs = database.database!.inputs;
  const store: Record<string, DataValue> = { ...(hasField(database, "name") && { name }) };
  store[dbInputs.region] = region;
  if (dbInputs.size && size) store[dbInputs.size] = size;
  Object.assign(store, DATABASE_EXTRAS[idOf(database)]?.({ ...(organization && { organization }) }));

  const { inputs } = host.host!;
  const hosted: Record<string, DataValue> = { ...(hasField(host, "name") && { name }) };
  if (hasField(host, "image")) {
    hosted.image =
      idOf(host) === DOCKER ? RUNTIME_IMAGE : `${PUBLISHED_IMAGE}:${await sanomaVersion(app.resolved.root!)}`;
  }
  hosted[inputs.source] = new Reference("repo");
  hosted[inputs.ref] = "main";
  hosted[inputs.secrets] = {
    SANOMA_DATABASE_URL: secret(DATABASE_URL),
    SANOMA_SECRETS_KEY: secret(SECRETS_KEY),
    ...wakeup.secrets,
  };
  hosted[inputs.port] = port;
  const woken = wakeup.type;
  return renderDataFile(
    {
      imports: [...new Set(["github", database.vendor, host.vendor, ...(woken ? [woken.vendor] : [])])].map(
        constructors,
      ),
      exports: [
        { name: "repo", vendor: "github", type: "repository", desired: { name, visibility: "private" } },
        { name: "store", vendor: database.vendor, type: database.type, desired: store },
        { name: "host", vendor: host.vendor, type: host.type, desired: hosted },
        ...(woken
          ? [
              {
                name: "wakeup",
                vendor: woken.vendor,
                type: woken.type,
                desired: { [woken.wakeup!.inputs.host]: new Reference("host") },
              },
            ]
          : []),
      ],
    },
    formatOptions(app.resolved.root!),
  );
}

/**
 * Step 3 and 4: writes `infra.ts` for the choices and commits it, stores the owner as the GitHub
 * connector's `GITHUB_OWNER`, and starts apply on the repository and the database. Apply creates
 * both, binds them in the lockfile and, once the project is healthy, stores its database URL
 * (its `afterCreate`). Refused once the file is written: going live writes it once.
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
  if (!(await client.secrets(["GITHUB_TOKEN"])).has("GITHUB_TOKEN")) {
    throw new ApiError(409, {
      error: "The GitHub connector creates the repository with GITHUB_TOKEN: connect a token",
    });
  }
  // A wakeup's token may be the environment's or its connector page's, which mint nothing.
  const stored = await connections(app);
  const host = hostType(app, stored);
  if (host && hostWakeup(app, host, stored).type) await mintWakeupToken(client, actor);
  const text = await renderInfra(app, choices);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await source?.commit({
    paths: [INFRA],
    message: "Go live: declare the repository, database and host",
    author: actor.id,
  });
  await client.setSecret("GITHUB_OWNER", choices.owner, { by: actor.id });
  const runId = await client.apply({ only: [KEYS.repo, KEYS.store] }, { startedBy: actor });
  return { runId };
}

/**
 * The token a push to the owner's repository signs in with: the stored `GITHUB_TOKEN`, else an
 * installation token of the GitHub App installed on the owner.
 */
async function pushToken(app: AppContext, owner: string): Promise<string> {
  const stored = await app.client.secrets(["GITHUB_TOKEN", GITHUB_APP.id, GITHUB_APP.pem]);
  const token = stored.get("GITHUB_TOKEN")?.value;
  if (token) return token;
  const installation = (await installations(app)).find((i) => i.account.login.toLowerCase() === owner.toLowerCase());
  if (!installation) throw new ApiError(409, { error: `No GitHub token, and the App is not installed on ${owner}` });
  const jwt = appJwt(stored.get(GITHUB_APP.id)!.value, stored.get(GITHUB_APP.pem)!.value);
  const { token: made } = await fetchJson<{ token: string }>(
    `${GITHUB_API}/app/installations/${installation.id}/access_tokens`,
    githubHeaders(jwt),
    "POST",
  );
  return made;
}

/**
 * Steps 5 and 6: pushes the local repository's `main`, with `infra.ts` and the lockfile on top,
 * to the repository apply made, then starts apply on the host (and its wakeup, when declared).
 * Refused until the repository and the database are bound.
 */
export async function goLiveHost(app: AppContext, actor: Principal): Promise<{ runId: string }> {
  const { client, resolved, source } = app;
  const { bindings } = readLockfile(resolved.root!);
  if (!bindings[KEYS.repo] || !bindings[KEYS.store]) {
    throw new ApiError(409, { error: "Apply the repository and the database first" });
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
      token: await pushToken(app, owner),
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
