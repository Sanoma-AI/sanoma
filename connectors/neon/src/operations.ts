import type { CallContext, PlanAction } from "@sanoma-ai/workflows";
import { DriverError, retryableStatus, storeDatabaseUrl } from "@sanoma-ai/workflows";
import { canonicalSize, DEFAULT_SIZE, fields, limitsOf, project, sizeOf } from "./connector.ts";

// The connector's operations over Neon's API (`NeonApi`): the driver's calls it through the SDK,
// the fake's answers from its state. Both go through `neonOperations`, so they plan, store the
// URL and refuse alike.

/** A project as Neon shows it: the fields read here. */
export interface ApiProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
}

/** A branch as Neon shows it: the fields read here. */
export interface ApiBranch {
  id: string;
  name: string;
  default: boolean;
}

/** A compute (Neon's endpoint) as Neon shows it: the fields read here. */
export interface ApiEndpoint {
  id: string;
  host: string;
  branch_id: string;
  type: string;
  /** `init` until it first starts, then `active`, or `idle` while suspended. */
  current_state: string;
  pending_state?: string;
  autoscaling_limit_min_cu: number;
  autoscaling_limit_max_cu: number;
}

/** A compute's size, as Neon takes it. */
export type Limits = ReturnType<typeof limitsOf>;

/** What `POST /projects` takes, cut to what the driver sends. */
export interface ProjectCreate {
  project: {
    name: string;
    region_id: string;
    pg_version?: number;
    default_endpoint_settings: Limits;
    branch: { database_name: string; role_name: string };
  };
}

/** What `POST /projects/{id}/branches` takes, cut to what the driver sends. */
export interface BranchCreate {
  branch: { name: string; expires_at?: string };
  endpoints: { type: "read_write" }[];
}

/** Neon's API, its answers as it sends them, cut. Each call fails with a `DriverError`. */
export interface NeonApi {
  createProject(body: ProjectCreate): Promise<{ project: ApiProject; branch: ApiBranch; endpoints: ApiEndpoint[] }>;
  /** Undefined when Neon has no such project (404). */
  getProject(id: string): Promise<ApiProject | undefined>;
  updateProject(id: string, body: { project: { name: string; default_endpoint_settings?: Limits } }): Promise<void>;
  /** Nothing when Neon has no such project (404). */
  deleteProject(id: string): Promise<void>;
  branches(projectId: string): Promise<ApiBranch[]>;
  endpoints(projectId: string): Promise<ApiEndpoint[]>;
  updateEndpoint(projectId: string, endpointId: string, body: { endpoint: Limits }): Promise<void>;
  /** `GET /projects/{id}/connection_uri`: the URI, with the role's password. */
  connectionUri(query: {
    projectId: string;
    branch_id?: string;
    database_name: string;
    role_name: string;
    pooled: boolean;
  }): Promise<string>;
  createBranch(
    projectId: string,
    body: BranchCreate,
  ): Promise<{ branch: ApiBranch; connection_uris?: { connection_uri: string }[] }>;
  /** Nothing when Neon has no such branch (404). */
  deleteBranch(projectId: string, branchId: string): Promise<void>;
  suspendEndpoint(projectId: string, endpointId: string): Promise<ApiEndpoint>;
  startEndpoint(projectId: string, endpointId: string): Promise<ApiEndpoint>;
}

/** The database and role a project is made with, which its URLs name: Neon's defaults, said out loud. */
export const DATABASE = "neondb";
export const ROLE = "neondb_owner";

/** The driver's own refusal, before or instead of a call: never retried. */
export const refused = (message: string, vendorCode?: string) =>
  new DriverError(`neon: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/**
 * Whether a call that Neon answered `status` is worth retrying: the runtime's rule, and a 423,
 * which Neon answers while the project's earlier operations (a new compute's start) still run.
 */
export const retryable = (status: number) => retryableStatus(status) || status === 423;

/** The fields a project's state holds that only Neon sets: unknown in a create's plan. */
const SET_BY_NEON = fields.vendorOwned;
/** The fields Neon cannot change in place: a project does not move or change its major version. */
const IMMUTABLE = fields.immutable;

/** A compute that has started once: active, or idle (suspended) since. */
const started = (endpoint: ApiEndpoint | undefined) =>
  endpoint !== undefined && ["active", "idle"].includes(endpoint.current_state);

/** A project's state, from Neon's project and its default branch's read-write compute. */
function stateOf(p: ApiProject, branch: ApiBranch | undefined, endpoint: ApiEndpoint | undefined) {
  return {
    name: p.name,
    region: p.region_id,
    pg_version: p.pg_version,
    id: p.id,
    ...(branch && { default_branch_id: branch.id }),
    ...(endpoint && {
      size: sizeOf(endpoint.autoscaling_limit_min_cu, endpoint.autoscaling_limit_max_cu),
      host: endpoint.host,
      default_endpoint_id: endpoint.id,
    }),
    healthy: started(endpoint),
  };
}
type State = ReturnType<typeof stateOf>;

/** What `plan` finds: the action, what it would leave, and the state it planned from. */
interface Planned {
  action: PlanAction;
  planned?: Record<string, unknown>;
  state?: State;
  /** For an update, the state it leaves: only the name and size change in place. */
  next?: State;
  unknown: string[];
  replace: string[];
}

/** The state a compute is going to: Neon answers a suspend or a start before it is done. */
const goingTo = (endpoint: ApiEndpoint) => ({ state: endpoint.pending_state ?? endpoint.current_state });

/**
 * The connector's operations over `neon`: the project type's (`project.*`, with `health` and
 * `storeUrl`), `branch.create` and `branch.delete`, `endpoint.suspend` and `endpoint.start`.
 */
export function neonOperations(neon: NeonApi) {
  /** A project's default branch, and that branch's read-write compute: either may be missing. */
  const defaults = async (projectId: string) => {
    // One after the other, so a recording holds them in one order.
    const branches = await neon.branches(projectId);
    const endpoints = await neon.endpoints(projectId);
    const branch = branches.find((b) => b.default);
    const endpoint = endpoints.find((e) => e.branch_id === branch?.id && e.type === "read_write");
    return { branch, endpoint };
  };
  /** The direct (unpooled) URI of a project's database, of its default branch unless `branchId`. */
  const directUri = (projectId: string, branchId?: string) =>
    neon.connectionUri({
      projectId,
      ...(branchId && { branch_id: branchId }),
      database_name: DATABASE,
      role_name: ROLE,
      pooled: false,
    });
  const read = async ({ id }: { id: string }) => {
    const found = await neon.getProject(id);
    if (!found) return { id, gone: true };
    const { branch, endpoint } = await defaults(id);
    return { id, gone: false, state: stateOf(found, branch, endpoint) };
  };
  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    const state = id === undefined ? undefined : (await read({ id })).state;
    const none = { unknown: [], replace: [] };
    if (!desired) return { action: state ? "delete" : "none", state, ...none };
    const want = project.schema.parse(desired);
    if (!state) {
      const unknown = [...SET_BY_NEON, ...(want.pg_version === undefined ? ["pg_version"] : [])];
      const planned = { size: DEFAULT_SIZE, ...want, ...Object.fromEntries(unknown.map((f) => [f, null])) };
      return { action: "create", planned, unknown, replace: [] };
    }
    const replace = IMMUTABLE.filter((f) => want[f] !== undefined && want[f] !== state[f]);
    if (replace.length) return { action: "replace", planned: { ...state, ...want }, state, unknown: [], replace };
    const next = { ...state, name: want.name, size: want.size === undefined ? state.size : canonicalSize(want.size) };
    const action = next.name !== state.name || next.size !== state.size ? "update" : "none";
    return { action, planned: next, state, next, ...none };
  };
  return {
    project: {
      import: read,
      read,
      plan: async (input: { id?: string; desired?: Record<string, unknown> }) => {
        const { state: _, next: __, ...out } = await plan(input);
        return out;
      },
      create: async ({ desired }: { desired: Record<string, unknown> }) => {
        const { name, region, size, pg_version } = project.schema.parse(desired);
        const made = await neon.createProject({
          project: {
            name,
            region_id: region,
            ...(pg_version !== undefined && { pg_version }),
            default_endpoint_settings: limitsOf(size),
            branch: { database_name: DATABASE, role_name: ROLE },
          },
        });
        const endpoint = made.endpoints.find((e) => e.type === "read_write");
        return { id: made.project.id, state: stateOf(made.project, made.branch, endpoint) };
      },
      update: async ({
        id,
        desired,
        expect,
      }: {
        id: string;
        desired: Record<string, unknown>;
        expect?: { action: PlanAction; replace: string[] };
      }) => {
        const fresh = await plan({ id, desired });
        if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
          throw refused(`project.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
        }
        const { state, next } = fresh;
        if (!state) throw refused(`project.update: there is no project ${id}`, "gone");
        if (fresh.action === "replace") {
          // Making a new project would leave the company's data in the old one.
          throw refused(
            `project.update: Neon cannot change a project's ${fresh.replace.join(" or ")}: declare a new project and move the data`,
            "immutable",
          );
        }
        if (fresh.action === "none" || !next) return { id, state };
        const resize = next.size !== state.size && next.size !== undefined;
        const limits = limitsOf(next.size);
        await neon.updateProject(id, {
          project: { name: next.name, ...(resize && { default_endpoint_settings: limits }) },
        });
        if (resize && state.default_endpoint_id) {
          await neon.updateEndpoint(id, state.default_endpoint_id, { endpoint: limits });
        }
        return { id, state: next };
      },
      delete: async ({ id }: { id: string }) => {
        await neon.deleteProject(id);
        return { id, gone: true as const };
      },
      health: async ({ id }: { id: string }) => {
        const { endpoint } = await defaults(id);
        return { healthy: started(endpoint), state: endpoint?.current_state ?? "none" };
      },
      // Direct, not pooled: Neon's pooler runs in transaction mode, which does not carry LISTEN, which DBOS needs.
      storeUrl: async ({ id, export: name }: { id: string; export: string }, { secrets }: CallContext) =>
        storeDatabaseUrl(secrets, name, await directUri(id), {
          where: "neon: project.storeUrl",
          others: "another project or password",
        }),
    },
    branch: {
      create: async ({
        project: projectId,
        name,
        expiresAt,
      }: {
        project: string;
        name: string;
        expiresAt?: string;
      }) => {
        const made = await neon.createBranch(projectId, {
          branch: {
            name,
            ...(expiresAt && { expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z") }),
          },
          endpoints: [{ type: "read_write" }],
        });
        // Neon sends the URI when the branch has one database and one role, as a project made here does.
        const url = made.connection_uris?.[0]?.connection_uri ?? (await directUri(projectId, made.branch.id));
        return { id: made.branch.id, url };
      },
      delete: async ({ project: projectId, id }: { project: string; id: string }) => {
        await neon.deleteBranch(projectId, id);
        return { id, gone: true as const };
      },
    },
    endpoint: {
      suspend: async ({ project: projectId, id }: { project: string; id: string }) =>
        goingTo(await neon.suspendEndpoint(projectId, id)),
      start: async ({ project: projectId, id }: { project: string; id: string }) =>
        goingTo(await neon.startEndpoint(projectId, id)),
    },
  };
}
