import { type CallContext, diffDeclared, DriverError, type PlanAction } from "sanoma/workflows";
import { cloudHostnameOf, cloudSlugOf } from "sanoma/workflows/shared";
import { z } from "zod";
import { database, host, PORT, REGIONS, repositoryOf } from "./connector.ts";

// The connector's operations over Sanoma Cloud's API (`CloudApi`, sanoma-ops's workflows):
// the driver's starts them over the public api, the fake's answers from its state. Both go
// through `cloudOperations`, so they plan, adopt and refuse alike. The company is the token's
// (one token, one company), named by its id in every call but a new company's sign-up and the
// boxes', which the Cloud finds by the token alone.

/**
 * What `cloud-signup` takes: a part made for the company `id`, or, with `slug` instead, for a new
 * company at that address (the token's first).
 */
export type SignupInput = ({ id: string; slug?: never } | { slug: string; id?: never }) & {
  /** A new company's display name: its slug, here. */
  name?: string;
  /**
   * The part made: the database, the host, or the company's repository, which the Sanoma.work
   * GitHub App makes empty in the account it is installed on, for a computer to push to.
   */
  part: "database" | "host" | "repository";
  repository?: { owner: string; name: string };
  ref?: string;
  /** The commit the host runs, which apply resolved from `ref`: by default the branch's head. */
  revision?: string;
  region?: (typeof REGIONS)[number];
};

/** One company as `cloud-list` answers it, the driver's check of the answer and the fake's shape: its id, its address, its trial, and the parts it has. */
export const CompanyRow = z.object({
  id: z.string().min(1),
  /** Its address now, `<slug>.sanoma.work`. */
  slug: z.string().min(1),
  /** Its display name. */
  name: z.string(),
  url: z.string(),
  status: z.string(),
  /** Why its last sign-up or close failed, while `status` is `failed`. */
  reason: z.string().optional(),
  /** When it was made and when its trial ends, ISO 8601. */
  createdAt: z.string(),
  trialEndsAt: z.string(),
  /** The commit its host runs: set while it has a host. */
  revision: z.string().optional(),
  database: z.object({ id: z.string(), healthy: z.boolean(), region: z.string().optional() }).optional(),
  repository: z.object({ owner: z.string(), name: z.string(), ref: z.string() }).optional(),
});
export type Company = z.output<typeof CompanyRow>;

/** Whether an address is free: `available` for anyone, or the token's account's own already (`yours`). */
export interface Availability {
  available: boolean;
  yours: boolean;
}

/** A link to one port of a box: it reaches the port with no credential until it expires, which the Cloud says and this does not keep. */
export interface BoxLink {
  url: string;
}

/** A box `cloud-box-open` opened: its instance, a link to its runner's port, and the runner protocol it speaks. */
export interface OpenedBox extends BoxLink {
  id: string;
  protocol: number;
}

/** Sanoma Cloud's API: sanoma-ops's workflows, each a run's output. Each call fails with a `DriverError`. */
export interface CloudApi {
  /** Its answer is not read: `create` reads the part from `list`, as `read` will. */
  signup(input: SignupInput): Promise<unknown>;
  /** The token's company, or the one `id` names when it is the token's: none when there is none (not found). */
  list(input: { id?: string }): Promise<Company[]>;
  /** Moves the host to `revision`, and the company to the address `slug` when it has another (a rename). */
  deploy(input: { id: string; slug: string; revision: string }): Promise<unknown>;
  close(input: { id: string; part: "database" | "host" }): Promise<unknown>;
  /** `cloud-available`: whether the address `<slug>.sanoma.work` is free, or the account's own. */
  available(input: { slug: string }): Promise<Availability>;
  /** `cloud-invite`: a one-use link that signs the account's own `email` in on the company's host. */
  invite(input: { id: string; email: string }): Promise<{ url: string }>;
  /**
   * `cloud-box-open`: the token's company's box `name`, found or made, woken, Sanoma's runner
   * started in it, reaching only `hosts`; a link to the runner's port.
   */
  boxOpen(input: { name: string; hosts: readonly string[] }): Promise<OpenedBox>;
  /** `cloud-box-expose`: a link to another `port` of the company's box `name`. */
  boxExpose(input: { name: string; port: number }): Promise<BoxLink>;
  /** `cloud-box-stop`: the company's box `name` put to sleep, its files and memory kept. */
  boxStop(input: { name: string }): Promise<unknown>;
  /** `cloud-box-discard`: the company's box `name` deleted, with what was kept of it. */
  boxDiscard(input: { name: string }): Promise<unknown>;
}

/** The driver's own refusal, before or instead of a call: never retried. */
const refused = (message: string, vendorCode?: string) =>
  new DriverError(`Sanoma Cloud: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

type State = Record<string, unknown>;
type HostState = z.output<typeof host.schema>;
type DatabaseState = z.output<typeof database.schema>;
type Planned = { action: PlanAction; planned?: State; unknown: string[]; replace: string[] };
type Expect = { action: PlanAction; replace: string[] };

const NONE = { unknown: [], replace: [] };

/** True when a company has a database: one the Cloud has not closed. */
const hasDatabase = (c: Company | undefined): c is Company & { database: { id: string } } =>
  c?.database !== undefined && c.status !== "closed";

/** True when a company has a host: the Cloud keeps its revision while it does. */
const hasHost = (c: Company | undefined): c is Company & { revision: string } =>
  typeof c?.revision === "string" && c.status !== "closed";

/** A host's state, from its company: its database the company's own, bound by the same id. */
function hostState(c: Company & { revision: string }): HostState {
  const hostname = cloudHostnameOf(c.slug);
  return {
    id: c.id,
    hostname,
    database: c.id,
    source: c.repository ? `https://github.com/${c.repository.owner}/${c.repository.name}.git` : "",
    ref: c.repository?.ref ?? "main",
    revision: c.revision,
    port: PORT,
    url: c.url,
    healthy: c.status !== "failed",
  };
}

/** A database's state, from its company. */
function databaseState(c: Company & { database: { id: string } }): DatabaseState {
  return {
    id: c.id,
    ...(c.database.region && { region: c.database.region as DatabaseState["region"] }),
    healthy: c.database.healthy,
  };
}

/** The immutable fields of `type` where `state` differs from what `desired` declares (`diffDeclared`, the type's `normalize`). */
function immutableChanged(type: Parameters<typeof diffDeclared>[0], state: State, desired: State): string[] {
  const changed = new Set(diffDeclared(type, state, desired).map((d) => d.path.split(".")[0]));
  return type.fields.immutable.filter((f) => changed.has(f));
}

/**
 * A plan's `expect` met, or a refusal: what apply was shown is what it changes. A plan of `none`
 * meets any: a retry of a change that went through finds it done.
 */
function expected(what: string, expect: Expect | undefined, fresh: Planned) {
  if (fresh.action === "none") return;
  if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
    throw refused(`${what}.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
  }
}

/** The company `id`, or undefined when the token holds none by it. */
const company = async (cloud: CloudApi, id: string) => (await cloud.list({ id })).find((c) => c.id === id);

/** The company the Cloud token is for (one token, one company), or undefined while it is for none; refused when it lists several. */
async function heldCompany(cloud: CloudApi): Promise<Company | undefined> {
  const held = await cloud.list({});
  if (held.length > 1) {
    throw refused(`the Cloud token lists ${held.length} companies, not its one: use a company's own token`, "not_one");
  }
  return held[0];
}

/**
 * The company the Cloud token is for: the one its database and host are made for. Refused while it
 * is for none, which signing in to Sanoma or the wizard makes.
 */
async function tokenCompany(cloud: CloudApi): Promise<Company> {
  const held = await heldCompany(cloud);
  if (held) return held;
  throw refused(
    "the Cloud token is for no company yet: sign up on www.sanoma.work, or go live from Hosting",
    "no_company",
  );
}

/** The boxes' state, from their company: they are the company's, bound by its id. */
const sandboxState = (c: Company) => ({ id: c.id, healthy: c.status !== "failed" });

/** A refusal to bind `what` the wizard made, whose `fields` differ from the declaration: it cannot change in place. */
const differs = (what: string, id: string, fields: string[]) =>
  refused(
    `${what}.create: the company ${id} has a ${what} already, whose ${fields.join(" and ")} differ from the declaration: declare its own, or close it first`,
    "immutable",
  );

const readDatabase = async (cloud: CloudApi, id: string) => {
  const found = await company(cloud, id);
  return hasDatabase(found) ? { id, gone: false, state: databaseState(found) } : { id, gone: true as const };
};
const planDatabase = async (
  cloud: CloudApi,
  { id, desired }: { id?: string; desired?: State },
): Promise<Planned & { state?: DatabaseState }> => {
  const state = id === undefined ? undefined : (await readDatabase(cloud, id)).state;
  if (!desired) return { action: state ? "delete" : "none", ...NONE, state };
  const want = database.schema.parse(desired);
  if (!state) {
    const { id: made } = await tokenCompany(cloud);
    return { action: "create", planned: { ...want, id: made, healthy: null }, unknown: ["healthy"], replace: [] };
  }
  const replace = immutableChanged(database, state, want);
  return { action: replace.length ? "replace" : "none", planned: { ...state, ...want }, unknown: [], replace, state };
};

const readHost = async (cloud: CloudApi, id: string) => {
  const found = await company(cloud, id);
  return hasHost(found) ? { id, gone: false, state: hostState(found) } : { id, gone: true as const };
};
const planHost = async (
  cloud: CloudApi,
  { id, desired }: { id?: string; desired?: State },
): Promise<Planned & { state?: HostState }> => {
  const state = id === undefined ? undefined : (await readHost(cloud, id)).state;
  if (!desired) return { action: state ? "delete" : "none", ...NONE, state };
  const want = host.schema.parse(desired);
  if (!state) {
    const { id: made } = await tokenCompany(cloud);
    return {
      action: "create",
      planned: { ...want, id: made, port: PORT, url: null, healthy: null },
      unknown: ["url", "healthy"],
      replace: [],
    };
  }
  const replace = immutableChanged(host, state, want);
  // A rename moves its URL to the new address, which the Cloud says once it is there.
  const renamed = want.hostname !== state.hostname;
  const planned = {
    ...state,
    hostname: want.hostname,
    ...(renamed && { url: null }),
    ...(want.revision && { revision: want.revision }),
  };
  if (replace.length) return { action: "replace", planned, unknown: [], replace, state };
  const moved = renamed || planned.revision !== state.revision;
  return { action: moved ? "update" : "none", planned, unknown: renamed ? ["url"] : [], replace: [], state };
};

/** The boxes of the company `id`, while it is open: gone once it is closed, which discards them. */
const readSandbox = async (cloud: CloudApi, id: string) => {
  const found = await company(cloud, id);
  return found && found.status !== "closed"
    ? { id, gone: false, state: sandboxState(found) }
    : { id, gone: true as const };
};

/** Without the plan's own fields: what a `plan` operation answers. */
function answer(planned: Planned & { state?: unknown }): Planned {
  const { state: _, ...out } = planned;
  return out;
}

/**
 * The host of the company `id`, as `now` reads it, at `hostname` and `revision`: `cloud-deploy`
 * when it runs another revision or is at another address (a rename). Its state after.
 */
async function deployed(cloud: CloudApi, id: string, now: HostState, hostname: string, revision: string) {
  if (now.hostname === hostname && now.revision === revision) return now;
  await cloud.deploy({ id, slug: cloudSlugOf(hostname)!, revision });
  const after = await readHost(cloud, id);
  if (!after.state) throw refused(`host: the host for ${id} is gone after its deploy`, "gone");
  return after.state;
}

/**
 * The connector's operations over the API `api(call)` gives for each call: the database type's
 * (`database.*`, with `storeUrl`), the host type's (`host.*`), the sandbox type's (`sandbox.*`, a
 * declaration bound to the company, whose boxes `cloudBackend` opens), and the account's
 * (`company.*`): whether an address is free, the company's repository made, a sign-in link on its
 * host.
 */
export function cloudOperations(api: (call: CallContext) => CloudApi) {
  const databaseRead = async ({ id }: { id: string }, call: CallContext) => readDatabase(api(call), id);
  const hostRead = async ({ id }: { id: string }, call: CallContext) => readHost(api(call), id);
  const sandboxRead = async ({ id }: { id: string }, call: CallContext) => readSandbox(api(call), id);
  /** Binds the declaration to the token's company, whose boxes the Cloud opens as people need them: nothing is made. */
  const sandboxBind = async (_: unknown, call: CallContext) => {
    const found = await tokenCompany(api(call));
    return { id: found.id, state: sandboxState(found) };
  };
  return {
    database: {
      import: databaseRead,
      read: databaseRead,
      plan: async (input: { id?: string; desired?: State }, call: CallContext) =>
        answer(await planDatabase(api(call), input)),
      create: async ({ desired }: { desired: State }, call: CallContext) => {
        const cloud = api(call);
        const want = database.schema.parse(desired);
        let found: Company | undefined = await tokenCompany(cloud);
        const { id } = found;
        if (hasDatabase(found)) {
          // The wizard made it with the company: bound now rather than made again, if it is the one declared.
          const changed = immutableChanged(database, databaseState(found), want);
          if (changed.length) throw differs("database", id, changed);
        } else {
          await cloud.signup({ id, part: "database", ...(want.region && { region: want.region }) });
          found = await company(cloud, id);
        }
        if (!hasDatabase(found)) throw refused(`database.create: the Cloud made no database for ${id}`, "not_made");
        return { id, state: databaseState(found) };
      },
      update: async ({ id, desired, expect }: { id: string; desired: State; expect?: Expect }, call: CallContext) => {
        const fresh = await planDatabase(api(call), { id, desired });
        expected("database", expect, fresh);
        if (!fresh.state) throw refused(`database.update: there is no database for ${id}`, "gone");
        if (fresh.action === "replace") {
          // A new database would leave the company's data in the old one.
          throw refused(
            `database.update: Sanoma Cloud cannot change a database's ${fresh.replace.join(" or ")}: declare a new one and move the data`,
            "immutable",
          );
        }
        return { id, state: fresh.state };
      },
      delete: async ({ id }: { id: string }, call: CallContext) => {
        const cloud = api(call);
        if (hasDatabase(await company(cloud, id))) await cloud.close({ id, part: "database" });
        return { id, gone: true as const };
      },
      storeUrl: async () => ({
        stored: false as const,
        reason: "Sanoma Cloud binds the database's URL to the company's host itself",
      }),
    },
    sandbox: {
      import: sandboxRead,
      read: sandboxRead,
      plan: async ({ id, desired }: { id?: string; desired?: State }, call: CallContext): Promise<Planned> => {
        if (!desired) return { action: id === undefined ? "none" : "delete", ...NONE };
        const state = id === undefined ? undefined : (await readSandbox(api(call), id)).state;
        if (state) return { action: "none", planned: state, ...NONE };
        const { id: made } = await tokenCompany(api(call));
        return { action: "create", planned: { id: made, healthy: null }, unknown: ["healthy"], replace: [] };
      },
      create: sandboxBind,
      update: sandboxBind,
      // The boxes stay until the company closes, which discards them; each is discarded on its own too (`SandboxBackend.discard`).
      delete: async ({ id }: { id: string }) => ({ id, gone: true as const }),
    },
    company: {
      available: (input: { slug: string }, call: CallContext) => api(call).available(input),
      repository: async ({ slug }: { slug: string }, call: CallContext) => {
        const cloud = api(call);
        // Made once: a retry, or a company the wizard made with its repository, reads the one there.
        let found = await heldCompany(cloud);
        if (!found?.repository) {
          await cloud.signup(found ? { id: found.id, part: "repository" } : { slug, name: slug, part: "repository" });
          found = await heldCompany(cloud);
        }
        if (!found?.repository) {
          throw refused(`company.repository: the Cloud made no repository for ${found?.id ?? slug}`, "not_made");
        }
        return { owner: found.repository.owner, name: found.repository.name };
      },
      invite: async ({ email }: { email: string }, call: CallContext) => {
        const cloud = api(call);
        return cloud.invite({ id: (await tokenCompany(cloud)).id, email });
      },
    },
    host: {
      import: hostRead,
      read: hostRead,
      plan: async (input: { id?: string; desired?: State }, call: CallContext) =>
        answer(await planHost(api(call), input)),
      create: async ({ desired }: { desired: State }, call: CallContext) => {
        const cloud = api(call);
        const want = host.schema.parse(desired);
        let found: Company | undefined = await tokenCompany(cloud);
        const { id } = found;
        if (hasHost(found)) {
          // The wizard made it with the company: bound now rather than made again, if it runs the
          // declared repository and branch (a deploy moves neither, and would rename the company).
          const changed = immutableChanged(host, hostState(found), want);
          if (changed.length) throw differs("host", id, changed);
        } else {
          const repository = repositoryOf(want.source);
          if (!repository) {
            throw refused(`host.create: ${want.source} names no repository (owner and name)`, "no_repository");
          }
          await cloud.signup({
            id,
            part: "host",
            repository,
            ...(want.ref && { ref: want.ref }),
            ...(want.revision && { revision: want.revision }),
          });
          found = await company(cloud, id);
        }
        // As `read` will see it: a host the list does not show would be made again by the next plan.
        if (!hasHost(found)) throw refused(`host.create: the Cloud made no host for ${id}`, "not_made");
        // At the declared address and apply's revision: a sign-up keeps the company's own address.
        return {
          id,
          state: await deployed(cloud, id, hostState(found), want.hostname, want.revision ?? found.revision),
        };
      },
      update: async ({ id, desired, expect }: { id: string; desired: State; expect?: Expect }, call: CallContext) => {
        const cloud = api(call);
        const fresh = await planHost(cloud, { id, desired });
        expected("host", expect, fresh);
        if (!fresh.state) throw refused(`host.update: there is no host for ${id}`, "gone");
        if (fresh.action === "replace") {
          throw refused(
            `host.update: Sanoma Cloud moves a host only to another revision or address, not its ${fresh.replace.join(" or ")}: delete it and declare it again`,
            "immutable",
          );
        }
        const { hostname, revision } = fresh.planned as HostState;
        return { id, state: await deployed(cloud, id, fresh.state, hostname, String(revision)) };
      },
      delete: async ({ id }: { id: string }, call: CallContext) => {
        const cloud = api(call);
        if (hasHost(await company(cloud, id))) await cloud.close({ id, part: "host" });
        return { id, gone: true as const };
      },
    },
  };
}
