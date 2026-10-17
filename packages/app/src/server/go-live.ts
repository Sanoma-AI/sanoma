// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { createSign } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APPLY_WORKFLOW, errorMessage, isEnded, type Principal, type Resource } from "@sanoma-ai/workflows";
import { type DataValue, formatOptions, readLockfile, Reference, renderDataFile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { ApiError, type GoLiveChoices, type GoLiveProgress, type GoLiveRequest, type GoLiveRun } from "../api.ts";
import type { AppContext } from "../context.ts";
import { asApplyPlan } from "../lib/apply-plan.ts";
import { GITHUB_APP } from "./setup.ts";

// Going live, steps 2 to 6 (step 1 is connect, in setup.ts): choose where the company goes,
// write `resources/sanoma/infra.ts`, apply the repository and the database, push the local
// repository to the new one, apply the host, and wait until it answers. Every change to a vendor
// is the built-in apply workflow's; what this file calls itself is only reading lists of accounts
// to choose from, and git.

/** The data file going live writes, relative to the config's root. */
export const INFRA = "resources/sanoma/infra.ts";

/** What `infra.ts` declares, by export: the lockfile's keys. */
const KEYS = { repo: `${INFRA}#repo`, store: `${INFRA}#store`, host: `${INFRA}#host` } as const;

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
/** The repository's name in `infra.ts` as `renderInfra` writes it. */
const REPO_NAME = /export const repo = github\.repository\(\{\s*name: "([^"]+)"/;
const SUPABASE_API = "https://api.supabase.com";

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

/** GET `url` with `token` as JSON, or an error saying who answered what. */
async function getJson<T>(url: string, headers: Record<string, string>, method = "GET"): Promise<T> {
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
  return getJson<Installation[]>(`${GITHUB_API}/app/installations`, githubHeaders(appJwt(id, pem)));
}

/**
 * What the page offers: the GitHub accounts the token (its user and organizations) and the App
 * (its installations) can make a repository in, the Supabase organizations the token sees,
 * Supabase's regions, and the host type. A list that cannot be read is empty, and says why.
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
  const supabase = tokens.get("SUPABASE_ACCESS_TOKEN")?.value;
  const [user, orgs, installed, organizations] = await Promise.all([
    github
      ? listed("GitHub's user", async () => [
          await getJson<{ login: string }>(`${GITHUB_API}/user`, githubHeaders(github)),
        ])
      : [],
    github
      ? listed("GitHub's organizations", () =>
          getJson<{ login: string }[]>(`${GITHUB_API}/user/orgs`, githubHeaders(github)),
        )
      : [],
    listed("The GitHub App's installations", () => installations(app)),
    supabase
      ? listed("Supabase's organizations", () =>
          getJson<{ id: string; name: string }[]>(`${SUPABASE_API}/v1/organizations`, {
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
  return {
    owners,
    organizations: organizations.map(({ id, name }) => ({ id, name })),
    regions: SUPABASE_REGIONS,
    host: host ? { type: `${host.vendor}.${host.type}`, title: host.title } : null,
    missing: [REPOSITORY, PROJECT].filter((type) => !app.resolved.types.has(type)).concat(host ? [] : ["a host"]),
    name: app.description.appName.replaceAll(/[^a-z0-9-]+/gi, "-").toLowerCase(),
    errors,
  };
}

/** `infra.ts`'s text for the choices: the repository, the database, and the host that runs the company from them. */
export async function renderInfra(app: AppContext, { name, organization, region, port }: Omit<GoLiveRequest, "owner">) {
  const host = hostType(app);
  const vendors = app.description.vendors;
  const missing = [REPOSITORY, PROJECT].filter((type) => !app.resolved.types.has(type));
  if (missing.length || !host) {
    const needs = [...missing, ...(host ? [] : ["a host type"])].join(", ");
    throw new ApiError(409, { error: `The config's connectors declare no ${needs}: add them to sanoma.config.ts` });
  }
  const constructors = (vendor: string) => {
    const pkg = vendors[vendor]?.package;
    if (!pkg) throw new ApiError(409, { error: `The ${vendor} connector names no package to import from` });
    return { source: `${pkg}/resources`, imported: vendor, local: vendor };
  };
  const { inputs } = host.host!;
  const fields = host.schema.shape as Record<string, unknown>;
  const hosted: Record<string, DataValue> = {
    ...("name" in fields && { name }),
    ...("image" in fields && { image: RUNTIME_IMAGE }),
  };
  hosted[inputs.source] = new Reference("repo");
  hosted[inputs.ref] = "main";
  hosted[inputs.secrets] = { SANOMA_DATABASE_URL: secret(DATABASE_URL), SANOMA_SECRETS_KEY: secret(SECRETS_KEY) };
  hosted[inputs.port] = port;
  return renderDataFile(
    {
      imports: [constructors("github"), constructors("supabase"), constructors(host.vendor)],
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
  const text = await renderInfra(app, choices);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await source?.commit({
    paths: [INFRA],
    message: "Go live: declare the repository, database and host",
    author: actor.id,
  });
  await client.setSecret("GITHUB_OWNER", choices.owner, { by: actor.id });
  // `SANOMA_SECRETS_KEY` is the host's from this process's environment, where the launcher's
  // `.env` sets it, and where the secrets store reads it first: there is nothing to store.
  if (!process.env[SECRETS_KEY]) throw new ApiError(409, { error: `${SECRETS_KEY} is not set` });
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
  const { token: made } = await getJson<{ token: string }>(
    `${GITHUB_API}/app/installations/${installation.id}/access_tokens`,
    githubHeaders(jwt),
    "POST",
  );
  return made;
}

/**
 * Steps 5 and 6: pushes the local repository's `main`, with `infra.ts` and the lockfile on top,
 * to the repository apply made, then starts apply on the host. Refused until the repository and
 * the database are bound.
 */
export async function goLiveHost(app: AppContext, actor: Principal): Promise<{ runId: string }> {
  const { client, resolved, source } = app;
  const { bindings } = readLockfile(resolved.root!);
  if (!bindings[KEYS.repo] || !bindings[KEYS.store]) {
    throw new ApiError(409, { error: "Apply the repository and the database first" });
  }
  if (!source?.push) throw new ApiError(409, { error: "The app has no repository to push from" });
  const owner = (await client.secrets(["GITHUB_OWNER"])).get("GITHUB_OWNER")?.value;
  // The repository's name as going live wrote it, first in the file.
  const name = REPO_NAME.exec(await readFile(join(resolved.root!, INFRA), "utf8"))?.[1];
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
  const runId = await client.apply({ only: [KEYS.host] }, { startedBy: actor });
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
  for (const run of await client.runs({ workflow: APPLY_WORKFLOW, status: "finished", limit: 10 })) {
    const result = (await client.applyReport(run.runId)).results.find((r) => r.id === KEYS.host && r.host);
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
