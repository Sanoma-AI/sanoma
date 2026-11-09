// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import {
  APPLY_WORKFLOW,
  errorMessage,
  HOST_SIGNING_KEY,
  isEnded,
  keyBytes,
  type Principal,
  postInvite,
  sealInvite,
  sourceKeyId,
  type Resource,
  wakeupHostTypes,
  wakeUrlOf,
} from "sanoma/workflows";
import type { DataValue } from "sanoma/workflows/describe";
import { secret } from "sanoma/resources";
import { WAKEUP_TOKEN } from "sanoma/workflows/wakeup-service";
import {
  ApiError,
  INFRA,
  type GoLiveChoices,
  type GoLiveProgress,
  type GoLiveRun,
  noWakeup,
  SETUP_VENDORS,
} from "../api.ts";
import type { AppContext } from "../context.ts";
import { asApplyPlan } from "../lib/apply-plan.ts";
import { invalid } from "./core.ts";
import { declaredEmail } from "./people.ts";
import { secretValues } from "./secrets.ts";
import { WAKEUP_URL } from "./setup.ts";

// Going live, steps 2 to 6 (step 1 is connect, in setup.ts): choose where the company goes,
// write `resources/sanoma/infra.ts`, apply the repository, the deploy key the host clones it with
// and the database, push the local repository to the new one, apply the host, and wait until it
// answers. Writing the file and pushing are the worker's, in the runs of the built-ins `go-live`
// and `go-live-host` (`steps/go-live.ts`). Every change to a vendor is the built-in apply workflow's; what this file calls itself
// is only reading lists of accounts to choose from, and git. The database, the host and the
// wakeup are chosen by their contracts (`database`, `host`, `wakeup`) among the config's resource
// types, never named but to prefer one.

/** What going live reads of the company, in a request (`AppContext`) and in the worker's runs (`AppStepContext`) alike. */
export type Company = Pick<AppContext, "resolved" | "client">;

/** What `infra.ts` declares, by export, and the deploy key apply declares for its host: the lockfile's keys. */
export const KEYS = {
  repo: `${INFRA}#repo`,
  deployKey: `${INFRA}#deployKey`,
  store: `${INFRA}#store`,
  host: `${INFRA}#host`,
  sourceKey: sourceKeyId(`${INFRA}#host`),
  wakeup: `${INFRA}#wakeup`,
  box: `${INFRA}#box`,
} as const;
/** The host's type in `infra.ts`, as `renderInfra` writes it. */
const HOST_LINE = /^export const host = (\w+)\.(\w+)\(/m;
/**
 * What the first apply makes (step 3), and what must be bound before the host's, of what `infra`
 * declares: the deploy key a host that derives is given by apply (minted then), or the one an
 * earlier file declares; a file written before deploy keys declares none, and its host clones as
 * it did.
 */
export const beforeHost = ({ resolved }: Company, infra: string) => {
  const [, vendor, type] = HOST_LINE.exec(infra) ?? [];
  if (resolved.types.get(`${vendor}.${type}`)?.host?.derives) return [KEYS.repo, KEYS.sourceKey, KEYS.store];
  return /^export const deployKey\b/m.test(infra) ? [KEYS.repo, KEYS.deployKey, KEYS.store] : [KEYS.repo, KEYS.store];
};

/** The repository type going live declares, and its deploy key's. */
const REPOSITORY = "github.repository";
const DEPLOY_KEY = "github.repository_deploy_key";

/** The database type going live prefers when the config has it: Neon's, which pauses. */
const NEON = "neon.project";
/** Supabase's project, the database type that takes an organization (`DATABASE_EXTRAS`). */
const SUPABASE = "supabase.project";
/** The host type going live prefers once Cloudflare is connected, then a container on this machine. */
const CLOUDFLARE = "cloudflare.host";
export const DOCKER = "docker.container";

/**
 * What going live fills in a database type beyond its contract's inputs, by type, from the
 * choices: Supabase's organization, and the password apply generates (the one its `storeUrl`
 * reads). A per-type extra rather than a rule on field names, until a second type needs one.
 */
export const DATABASE_EXTRAS: Record<string, (choices: { organization?: string }) => Record<string, DataValue>> = {
  [SUPABASE]: ({ organization }) => {
    if (!organization) invalid("organization", "Choose a Supabase organization");
    return {
      organization_id: organization,
      database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
    };
  },
};

const GITHUB_API = "https://api.github.com";

export const idOf = (type: Resource) => `${type.vendor}.${type.type}`;

/**
 * The resource types going live may choose from: all but those of a vendor whose host binds its
 * own bootstrap (Sanoma Cloud's), whose database and host go together in a file of their own
 * that going live does not write yet (#514 G1).
 */
function offered({ resolved }: Company): Resource[] {
  const types = [...resolved.types.values()];
  const own = new Set(types.filter((type) => type.host?.bindsBootstrap).map((type) => type.vendor));
  return types.filter((type) => !own.has(type.vendor));
}

/**
 * What going live declares that the config's connectors do not: the repository type and its
 * deploy key's (a GitHub connector of an earlier release has none), a database type, a host type.
 */
export const missingTypes = (app: Company) => {
  const { resolved } = app;
  const types = offered(app);
  return [
    ...[REPOSITORY, DEPLOY_KEY].filter((id) => !resolved.types.has(id)),
    ...(types.some((type) => type.database) ? [] : ["a database type"]),
    ...(types.some((type) => type.host) ? [] : ["a host type"]),
  ];
};

/**
 * The secrets going live reads: GitHub's token (for the lists the page offers),
 * and those that say which vendors are connected (`SETUP_VENDORS`' tokens).
 */
const connections = async ({ client, resolved }: Company, actor?: Principal) => {
  const named = new Map<string, boolean>(
    [...resolved.connections.catalog.methods]
      .filter(([, methods]) => Object.keys(methods).length > 0)
      .map(([vendor]) => [vendor, false]),
  );
  // Read account metadata only for an admitted person. Generating infrastructure uses the
  // explicit default in code; one configured account does not become an implicit default.
  if (named.size && actor) {
    const cards = await client.connections({ actor });
    for (const definition of resolved.connections.catalog.definitions.values()) {
      if (!definition.default) continue;
      const card = cards.find((entry) => entry.id === definition.$connection);
      named.set(definition.vendor, card?.status === "connected" && (!card.health || card.health.state === "connected"));
    }
  }
  const names = [...new Set(["GITHUB_TOKEN", ...SETUP_VENDORS.flatMap((v) => v.tokens)])].filter(
    (name) =>
      !named.has(
        name === "GITHUB_TOKEN" ? "github" : (SETUP_VENDORS.find((v) => v.tokens.includes(name))?.vendor ?? ""),
      ),
  );
  return { tokens: await client.secrets(names), named };
};
type Connections = Awaited<ReturnType<typeof connections>>;

/**
 * True when every token that connects `vendor` is stored; true for a vendor `/setup` does not
 * connect (Docker's, or one whose credentials its connector page holds), which it cannot tell,
 * unless `strictly`: then only a `/setup` vendor can be, for what going live may leave out (a wakeup).
 */
const isConnected = (stored: Connections, vendor: string, strictly = false) => {
  if (stored.named.has(vendor)) return stored.named.get(vendor)!;
  const setup = SETUP_VENDORS.find((v) => v.vendor === vendor);
  return setup ? setup.tokens.every((name) => stored.tokens.has(name)) : !strictly;
};

/**
 * Of the config's types that meet a contract, the first of `preferred` whose vendor is
 * connected, else the first connected; when none is, the same over all (the page asks to connect).
 */
function pick(app: Company, stored: Connections, meets: (type: Resource) => unknown, preferred: string[]) {
  const all = offered(app).filter(meets);
  const connected = all.filter((type) => isConnected(stored, type.vendor));
  const among = connected.length ? connected : all;
  return preferred.map((id) => among.find((type) => idOf(type) === id)).find(Boolean) ?? among[0];
}

/** The titles of the vendors to connect before going live: the chosen database's and host's, when not connected. */
export const toConnect = ({ stored, database, host }: Awaited<ReturnType<typeof choose>>) =>
  [database, host].flatMap((type) =>
    type && !isConnected(stored, type.vendor)
      ? [
          stored.named.has(type.vendor)
            ? `${type.vendor}'s declared default connection`
            : (SETUP_VENDORS.find((v) => v.vendor === type.vendor)?.title ?? type.vendor),
        ]
      : [],
  );

/**
 * What going live chooses now, from what is connected: the database (Neon's first), the host
 * (Cloudflare's first, then Docker's), its wakeup, and the coding agents' box: the first sandbox
 * type whose vendor is connected (`SETUP_VENDORS`), none otherwise.
 */
export async function choose(app: Company, actor?: Principal) {
  const stored = await connections(app, actor);
  const database = pick(app, stored, (type) => type.database, [NEON]);
  const host = pick(app, stored, (type) => type.host, [CLOUDFLARE, DOCKER]);
  const sandbox = offered(app).find((type) => type.sandbox && isConnected(stored, type.vendor, true));
  return { stored, database, host, wakeup: host ? hostWakeup(app, host, stored) : {}, sandbox };
}

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

/**
 * The GitHub connector's remote half over the stored credentials alone: going live lists accounts
 * with the stored `GITHUB_TOKEN` (`connections`), so it pushes with that one too, not one this
 * process's environment happens to have.
 */
export const githubOf = (app: Company) => ({
  remote: app.resolved.remotes.get("github"),
  context: { secrets: secretValues(app.client) },
});

/**
 * What the page offers: the GitHub accounts the token (its user and organizations) and the App
 * (its installations) can make a repository in, the database type with its regions and the
 * Supabase organizations the token sees when it is Supabase's, and the host type. A list that
 * cannot be read is empty, and says why.
 */
export async function goLiveChoices(app: AppContext, actor?: Principal): Promise<GoLiveChoices> {
  const errors: string[] = [];
  const chosen = await choose(app, actor);
  const {
    stored: { tokens },
    database,
    host,
    wakeup,
  } = chosen;
  const listed = async <T>(what: string, list: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await list();
    } catch (err) {
      errors.push(`${what}: ${errorMessage(err)}`);
      return [];
    }
  };
  const github = tokens.get("GITHUB_TOKEN")?.value;
  // Supabase's organizations, for a Supabase project's `organization_id` (`DATABASE_EXTRAS`):
  // its own operation, as the person, through the vendor's declared default connection.
  const organized = database !== undefined && idOf(database) === SUPABASE;
  const supabase = organized && actor !== undefined && isConnected(chosen.stored, "supabase");
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
      ? listed("Supabase's organizations", async () => {
          const listing = await app.client.call("supabase.organization.list", {}, { actor });
          return (listing as { organizations: { id: string; name: string }[] }).organizations;
        })
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
      app.snapshot.description.name
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
  { resolved }: Company,
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
      cannot: noWakeup(id, wakes.join("; ")),
    };
  }
  const service = type.vendor === "sanoma";
  return {
    type,
    secrets: { [WAKEUP_TOKEN]: secret(WAKEUP_TOKEN), ...(service && { [WAKEUP_URL]: secret(WAKEUP_URL) }) },
  };
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

/**
 * Signs the person going live in on the host, once it answers: posts an invite request sealed
 * under the signing key the host shares (`sealInvite`), or the host's own (`HOST_SIGNING_KEY`)
 * when the config binds none, for the email the people file declares for
 * them to the host's `POST /auth/invite`, and returns the one-use link it mints, for the page to
 * open. Refused before the host answers, and for someone with no email declared.
 */
export async function goLiveSignIn(app: AppContext, actor: Principal): Promise<{ url: string }> {
  const host = await hostAnswer(app);
  if (!host?.healthy) throw new ApiError(409, { error: "The host is not answering yet" });
  const email = declaredEmail(app, actor.id);
  if (!email) {
    throw new ApiError(409, { error: `${actor.id} has no email declared in the people file: add one to be signed in` });
  }
  // With no signing key bound, a host that derives has its own, generated at its create: sealed with that one.
  const own = app.resolved.secrets.bindings?.SANOMA_SIGNING_KEY
    ? undefined
    : (await app.client.secrets([HOST_SIGNING_KEY])).get(HOST_SIGNING_KEY)?.value;
  try {
    return await postInvite(host.url, sealInvite({ email }, own === undefined ? undefined : keyBytes(own)));
  } catch (err) {
    throw new ApiError(502, { error: `The host did not mint an invite (${errorMessage(err)})` });
  }
}

/**
 * Where the host answers, from the latest finished apply runs that made or changed it, and
 * whether `/healthz` answers at its wake URL (`wakeUrlOf`), as the host kit asks: a new
 * hostname's DNS and certificate may not be ready while the app already answers there.
 */
async function hostAnswer({ client }: AppContext): Promise<GoLiveProgress["host"]> {
  const runs = await client.runs({ workflow: APPLY_WORKFLOW, status: "finished", limit: 10 });
  const reports = await Promise.all(runs.map((run) => client.applyReport(run.runId)));
  for (const report of reports) {
    const result = report.results.find((r) => r.id === KEYS.host && r.host);
    if (result?.host) {
      const { url, healthy } = result.host;
      const answers = await fetch(new URL("/healthz", wakeUrlOf(result.host)), { signal: AbortSignal.timeout(2_000) })
        .then((res) => res.ok)
        .catch(() => false);
      return { url, healthy: healthy && answers };
    }
  }
  return null;
}

/** How far going live is: `infra.ts` and the lockfile's bindings as the snapshot read them, the latest apply run and the host. */
export async function goLiveProgress(app: AppContext): Promise<GoLiveProgress> {
  const { infra, bound: bindings } = app.snapshot;
  const before = beforeHost(app, infra ?? "");
  const bound = { beforeHost: before.every((key) => bindings.includes(key)), host: bindings.includes(KEYS.host) };
  const run = await latestRun(app);
  return {
    infra,
    beforeHost: before,
    bound,
    run,
    host: bound.host && run && isEnded(run.status) ? await hostAnswer(app) : null,
  };
}
