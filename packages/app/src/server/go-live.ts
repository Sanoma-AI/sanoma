// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createSign } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APPLY_WORKFLOW, errorMessage, isEnded, type Principal, type Resource } from "@sanoma-ai/workflows";
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
import { GITHUB_APP, SANOMA_OPS_WAKEUP } from "./setup.ts";

// Going live, steps 2 to 6 (step 1 is connect, in setup.ts): choose where the company goes,
// write `resources/sanoma/infra.ts`, apply the repository and the database, push the local
// repository to the new one, apply the host, and wait until it answers. Every change to a vendor
// is the built-in apply workflow's; what this file calls itself is only reading lists of accounts
// to choose from, and git.

/** What `infra.ts` declares, by export: the lockfile's keys. */
const KEYS = {
  repo: `${INFRA}#repo`,
  store: `${INFRA}#store`,
  host: `${INFRA}#host`,
  wakeup: `${INFRA}#wakeup`,
} as const;

/** The resource types going live declares, besides a host. */
const REPOSITORY = "github.repository";
const PROJECT = "supabase.project";

/** The host type going live prefers, when the config has it: a container on this machine. */
const DOCKER = "docker.container";

/** The runtime image a container host runs: `docker build -t sanoma-runtime packages/sanoma/runtime`. */
export const RUNTIME_IMAGE = "sanoma-runtime";

/** The secret the Supabase project's database URL is stored in (`supabase.database.storeUrl` for the export `store`). */
const DATABASE_URL = "SANOMA_DATABASE_URL_STORE";
const SECRETS_KEY = "SANOMA_SECRETS_KEY";
/** The wakeup service's URL, when "Connect sanoma-ops" stored one: the worker on the host registers there. */
const OPS_URL = "SANOMA_OPS_URL";

/** Supabase's regions, as a project's `region` takes them. */
export const SUPABASE_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
] as const;

const GITHUB_API = "https://api.github.com";
/** The wakeup's declaration in `infra.ts`, as `renderInfra` writes it. */
const WAKEUP_LINE = /^export const wakeup = /m;
/** The repository's name in `infra.ts` as `renderInfra` writes it. */
const REPO_NAME = /export const repo = github\.repository\(\{\s*name: "([^"]+)"/;
const SUPABASE_API = "https://api.supabase.com";

/** The resource types going live declares that the config's connectors do not, and a host when it has none. */
const missingTypes = (app: AppContext) =>
  [REPOSITORY, PROJECT].filter((type) => !app.resolved.types.has(type)).concat(hostType(app) ? [] : ["a host type"]);

/** The config's host type: Docker's when it has it, else the first. */
function hostType({ resolved }: AppContext): Resource | undefined {
  const hosts = [...resolved.types.values()].filter((type) => type.host);
  return hosts.find((type) => `${type.vendor}.${type.type}` === DOCKER) ?? hosts[0];
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
 * (its installations) can make a repository in, the Supabase organizations the token sees,
 * Supabase's regions, and the host type. A list that cannot be read is empty, and says why.
 */
export async function goLiveChoices(app: AppContext): Promise<GoLiveChoices> {
  const errors: string[] = [];
  const tokens = await app.client.secrets(["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN", "SANOMA_OPS_TOKEN"]);
  const listed = async <T>(what: string, list: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await list();
    } catch (err) {
      errors.push(`${what}: ${errorMessage(err)}`);
      return [];
    }
  };
  const github = tokens.get("GITHUB_TOKEN")?.value;
  const supabase = tokens.get("SUPABASE_ACCESS_TOKEN")?.value;
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
  const host = hostType(app);
  const cannot = host && tokens.has("SANOMA_OPS_TOKEN") ? unwakeable(app, host) : undefined;
  if (cannot) errors.push(cannot);
  return {
    owners,
    organizations: organizations.map(({ id, name }) => ({ id, name })),
    regions: SUPABASE_REGIONS,
    host: host ? { type: `${host.vendor}.${host.type}`, title: host.title } : null,
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
 * Why the config's sanoma-ops wakeup cannot wake its host type, or undefined when it can or the
 * config declares none: going live then declares no wakeup, and the choices say why.
 */
function unwakeable({ resolved }: AppContext, host: Resource): string | undefined {
  const type = resolved.types.get(SANOMA_OPS_WAKEUP);
  if (!type?.wakeup) return undefined;
  const hosts = [type.fields.references?.[type.wakeup.inputs.host]?.type ?? []].flat();
  const id = `${host.vendor}.${host.type}`;
  return hosts.includes(id)
    ? undefined
    : `sanoma-ops's wakeup cannot wake a ${id} (it wakes ${hosts.join(", ")}): going live declares none, and the host stays up`;
}

/**
 * The secrets the host is given for its wakeup, when going live declares one: the config has
 * sanoma-ops's wakeup type, for this host type, and "Connect sanoma-ops" stored the account's
 * token and minted the instance's, which the worker on the host registers with, at
 * `SANOMA_OPS_URL` when one is stored. Undefined for no wakeup.
 */
async function wakeupSecrets(app: AppContext, host: Resource) {
  if (!app.resolved.types.has(SANOMA_OPS_WAKEUP) || unwakeable(app, host)) return undefined;
  const stored = await app.client.secrets(["SANOMA_OPS_TOKEN", WAKEUP_TOKEN, OPS_URL]);
  if (!stored.has("SANOMA_OPS_TOKEN") || !stored.has(WAKEUP_TOKEN)) return undefined;
  return Object.fromEntries([WAKEUP_TOKEN, ...(stored.has(OPS_URL) ? [OPS_URL] : [])].map((n) => [n, secret(n)]));
}

/**
 * `infra.ts`'s text for the choices: the repository, the database, the host that runs the company
 * from them and, once sanoma-ops is connected, the wakeup that starts the host again, whose
 * instance token the host is given from the first apply (`wakeupSecrets`).
 */
export async function renderInfra(app: AppContext, { name, organization, region, port }: Omit<GoLiveRequest, "owner">) {
  const host = hostType(app);
  const vendors = app.description.vendors;
  const missing = missingTypes(app);
  if (missing.length || !host) {
    throw new ApiError(409, {
      error: `The config's connectors declare no ${missing.join(", ")}: add them to sanoma.config.ts`,
    });
  }
  const constructors = (vendor: string) => {
    const pkg = vendors[vendor]?.package;
    if (!pkg) throw new ApiError(409, { error: `The ${vendor} connector names no package to import from` });
    return { source: `${pkg}/resources`, imported: vendor, local: vendor };
  };
  const wakeup = await wakeupSecrets(app, host);
  const { inputs } = host.host!;
  const fields = host.schema.shape as Record<string, unknown>;
  const hosted: Record<string, DataValue> = {
    ...("name" in fields && { name }),
    ...("image" in fields && { image: RUNTIME_IMAGE }),
  };
  hosted[inputs.source] = new Reference("repo");
  hosted[inputs.ref] = "main";
  hosted[inputs.secrets] = {
    SANOMA_DATABASE_URL: secret(DATABASE_URL),
    SANOMA_SECRETS_KEY: secret(SECRETS_KEY),
    ...wakeup,
  };
  hosted[inputs.port] = port;
  return renderDataFile(
    {
      imports: [
        constructors("github"),
        constructors("supabase"),
        constructors(host.vendor),
        ...(wakeup ? [constructors("sanomaOps")] : []),
      ],
      exports: [
        { name: "repo", vendor: "github", type: "repository", desired: { name, visibility: "private" } },
        {
          name: "store",
          vendor: "supabase",
          type: "project",
          desired: {
            name,
            organization_id: organization,
            region,
            database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
          },
        },
        { name: "host", vendor: host.vendor, type: host.type, desired: hosted },
        ...(wakeup
          ? [{ name: "wakeup", vendor: "sanomaOps", type: "wakeup", desired: { host: new Reference("host") } }]
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
  // The project's `afterCreate` stores it; a project bound without it (a hook that failed) cannot run a host.
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
