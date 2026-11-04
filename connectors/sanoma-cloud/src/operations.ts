import { type CallContext, diffDeclared, DriverError, type PlanAction } from "@sanoma-ai/workflows";
import type { z } from "zod";
import { database, host, hostSlug, PORT, REGIONS, repositoryOf, SLUG, SLUG_RULE } from "./connector.ts";

// The connector's operations over Sanoma Cloud's API (`CloudApi`, sanoma-ops's four workflows):
// the driver's starts them over the public api, the fake's answers from its state. Both go
// through `cloudOperations`, so they plan, adopt and refuse alike.

/** What `cloud-signup` takes: a company's part made, for a slug the token's account owns or that is free. */
export interface SignupInput {
  slug: string;
  /** The company's display name: its slug, here. */
  name: string;
  part: "database" | "host";
  repository?: { owner: string; name: string };
  ref?: string;
  /**
   * The commit the host runs, which apply resolved from `ref`: beyond #514's table, so a workflow
   * that does not take it drops it, and `create` deploys it after when the host runs another.
   */
  revision?: string;
  region?: (typeof REGIONS)[number];
  domains?: Record<string, string>;
}

/** One company as `cloud-list` reads it: the parts it has. */
export interface Company {
  slug: string;
  url?: string;
  /** The commit its host runs: set while it has a host. */
  revision?: string;
  status?: string;
  /** Whether its host runs, when the Cloud says. */
  healthy?: boolean;
  database?: { id: string; healthy?: boolean; region?: string };
  repository?: { owner: string; name: string; ref?: string };
  domains?: Record<string, string>;
}

/** Sanoma Cloud's API: sanoma-ops's workflows, each a run's output. Each call fails with a `DriverError`. */
export interface CloudApi {
  /** Its answer is not read: `create` reads the part from `list`, as `read` will. */
  signup(input: SignupInput): Promise<unknown>;
  /** The token's companies, or the one at `slug`: none when it has none (not found). */
  list(input: { slug?: string }): Promise<Company[]>;
  deploy(input: { slug: string; revision: string }): Promise<unknown>;
  close(input: { slug: string; part: "database" | "host" }): Promise<unknown>;
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

/** A host's state, from its company. */
function hostState(c: Company & { revision: string }): HostState {
  const url = c.url ?? `https://${c.slug}.sanoma.work`;
  return {
    name: c.slug,
    source: c.repository ? `https://github.com/${c.repository.owner}/${c.repository.name}.git` : "",
    ref: c.repository?.ref ?? "main",
    revision: c.revision,
    port: PORT,
    // The Cloud serves a company at its own address, whatever `url` the list gives.
    domains: c.domains ?? { app: `${c.slug}.sanoma.work` },
    hostname: c.domains?.app ?? `${c.slug}.sanoma.work`,
    url,
    healthy: c.healthy ?? c.status !== "failed",
  };
}

/** A database's state, from its company. */
function databaseState(c: Company & { database: { id: string } }): DatabaseState {
  return {
    name: c.slug,
    ...(c.database.region && { region: c.database.region as DatabaseState["region"] }),
    id: c.database.id,
    healthy: c.database.healthy ?? c.status !== "failed",
  };
}

/** The immutable fields of `type` where `state` differs from what `desired` declares (`diffDeclared`, the type's `normalize`). */
function immutableChanged(type: Parameters<typeof diffDeclared>[0], state: State, desired: State): string[] {
  const changed = new Set(diffDeclared(type, state, desired).map((d) => d.path.split(".")[0]));
  return type.fields.immutable.filter((f) => changed.has(f));
}

/** A plan's `expect` met, or a refusal: what apply was shown is what it changes. */
function expected(what: string, expect: Expect | undefined, fresh: Planned) {
  if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
    throw refused(`${what}.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
  }
}

/** A host's slug (`hostSlug`), refused at plan when what it is made from is no slug the Cloud takes. */
function slugOf(want: HostState): string {
  const slug = hostSlug(want);
  if (!SLUG.test(slug)) {
    throw refused(
      `a cloud.host's slug, made from its name, hostname or repository, is ${slug ? `"${slug}"` : "empty"}, not ${SLUG_RULE}: declare \`name\``,
      "no_slug",
    );
  }
  return slug;
}

/** The company at `slug`, or undefined when the token holds none there. */
const company = async (cloud: CloudApi, slug: string) => (await cloud.list({ slug })).find((c) => c.slug === slug);

/**
 * A database's slug: its `name`, else the one Cloud company the token holds (the host's, which
 * makes it), with that company; refused when the token holds none or several.
 */
const databaseSlug = async (cloud: CloudApi, name: string | undefined): Promise<{ slug: string; held?: Company }> => {
  if (name) return { slug: name };
  const held = (await cloud.list({})).filter((c) => c.status !== "closed");
  if (held.length === 1) return { slug: held[0]!.slug, held: held[0] };
  throw refused(
    `a cloud.database with no name takes the one Cloud company its token holds, and it holds ${held.length ? held.length : "none"}: ` +
      "declare `name`, the company's slug, or apply the host first",
    "no_slug",
  );
};

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
    const { slug: name } = await databaseSlug(cloud, want.name);
    return {
      action: "create",
      planned: { ...want, name, id: null, healthy: null },
      unknown: ["id", "healthy"],
      replace: [],
    };
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
  const name = slugOf(want);
  if (!state) {
    return {
      action: "create",
      planned: { ...want, name, port: PORT, url: null, healthy: null },
      unknown: ["url", "healthy"],
      replace: [],
    };
  }
  const replace = immutableChanged(host, state, { ...want, name });
  const planned = { ...state, ...(want.revision && { revision: want.revision }) };
  if (replace.length) return { action: "replace", planned, unknown: [], replace, state };
  const action = want.revision && want.revision !== state.revision ? "update" : "none";
  return { action, planned, unknown: [], replace: [], state };
};

/** Without the plan's own fields: what a `plan` operation answers. */
function answer(planned: Planned & { state?: unknown }): Planned {
  const { state: _, ...out } = planned;
  return out;
}

/**
 * The connector's operations over the API `api(call)` gives for each call: the database type's
 * (`database.*`, with `storeUrl`) and the host type's (`host.*`).
 */
export function cloudOperations(api: (call: CallContext) => CloudApi) {
  const databaseRead = async ({ id }: { id: string }, call: CallContext) => readDatabase(api(call), id);
  const hostRead = async ({ id }: { id: string }, call: CallContext) => readHost(api(call), id);
  return {
    database: {
      import: databaseRead,
      read: databaseRead,
      plan: async (input: { id?: string; desired?: State }, call: CallContext) =>
        answer(await planDatabase(api(call), input)),
      create: async ({ desired }: { desired: State }, call: CallContext) => {
        const cloud = api(call);
        const want = database.schema.parse(desired);
        const { slug, held } = await databaseSlug(cloud, want.name);
        // The wizard made it with the company: bound now rather than made again.
        let found = held ?? (await company(cloud, slug));
        if (!hasDatabase(found)) {
          await cloud.signup({ slug, name: slug, part: "database", ...(want.region && { region: want.region }) });
          found = await company(cloud, slug);
        }
        if (!hasDatabase(found)) throw refused(`database.create: the Cloud made no database for ${slug}`, "not_made");
        return { id: slug, state: databaseState(found) };
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
        if (hasDatabase(await company(cloud, id))) await cloud.close({ slug: id, part: "database" });
        return { id, gone: true as const };
      },
      storeUrl: async () => ({
        stored: false as const,
        reason: "Sanoma Cloud binds the database's URL to the company's host itself",
      }),
    },
    host: {
      import: hostRead,
      read: hostRead,
      plan: async (input: { id?: string; desired?: State }, call: CallContext) =>
        answer(await planHost(api(call), input)),
      create: async ({ desired }: { desired: State }, call: CallContext) => {
        const cloud = api(call);
        const want = host.schema.parse(desired);
        const slug = slugOf(want);
        const repository = repositoryOf(want.source);
        if (!repository)
          throw refused(`host.create: ${want.source} names no repository (owner and name)`, "no_repository");
        await cloud.signup({
          slug,
          name: slug,
          part: "host",
          repository,
          ...(want.ref && { ref: want.ref }),
          ...(want.revision && { revision: want.revision }),
          // The address as the Cloud takes it: `domains.app`, which `hostname` now declares.
          ...((want.hostname ?? want.domains) && { domains: want.hostname ? { app: want.hostname } : want.domains }),
        });
        let found = await company(cloud, slug);
        // A workflow that drops `revision` runs the host at its own: moved to apply's.
        if (want.revision && hasHost(found) && found.revision !== want.revision) {
          await cloud.deploy({ slug, revision: want.revision });
          found = await company(cloud, slug);
        }
        // As `read` will see it: a host the list does not show would be made again by the next plan.
        if (!hasHost(found)) throw refused(`host.create: the Cloud made no host for ${slug}`, "not_made");
        return { id: slug, state: hostState(found) };
      },
      update: async ({ id, desired, expect }: { id: string; desired: State; expect?: Expect }, call: CallContext) => {
        const cloud = api(call);
        const fresh = await planHost(cloud, { id, desired });
        expected("host", expect, fresh);
        if (!fresh.state) throw refused(`host.update: there is no host for ${id}`, "gone");
        if (fresh.action === "replace") {
          throw refused(
            `host.update: Sanoma Cloud moves a host only to another revision, not its ${fresh.replace.join(" or ")}: delete it and declare it again`,
            "immutable",
          );
        }
        if (fresh.action === "none") return { id, state: fresh.state };
        await cloud.deploy({ slug: id, revision: String(fresh.planned!.revision) });
        const after = await readHost(cloud, id);
        if (!after.state) throw refused(`host.update: the host for ${id} is gone after its deploy`, "gone");
        return { id, state: after.state };
      },
      delete: async ({ id }: { id: string }, call: CallContext) => {
        const cloud = api(call);
        if (hasHost(await company(cloud, id))) await cloud.close({ slug: id, part: "host" });
        return { id, gone: true as const };
      },
    },
  };
}
