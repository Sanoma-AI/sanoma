import { DriverError } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { limitsOf, neonOps, REGIONS } from "./connector.ts";
import {
  type ApiBranch,
  type ApiEndpoint,
  type ApiProject,
  DATABASE,
  type Limits,
  type NeonApi,
  neonOperations,
  retryable,
  ROLE,
} from "./operations.ts";

/** A project of the fake Neon, as it keeps one: Neon's project, its branches and computes by id. */
export interface FakeNeonProject {
  project: ApiProject;
  branches: Record<string, ApiBranch & { expires_at?: string }>;
  endpoints: Record<string, ApiEndpoint>;
  /** The role's password, which its URLs carry. */
  password: string;
}

export interface FakeNeonState extends Record<string, unknown> {
  /** Counts up, for ids made in order. */
  seq: number;
  projects: Record<string, FakeNeonProject>;
}

/** Neon's default major version for a new project. */
const PG_VERSION = 17;

/** A `DriverError` as the driver makes one of Neon's answer `status`. */
const fail = (status: number, message: string) =>
  new DriverError(`neon: ${message}`, { retryable: retryable(status), status });

/** A URL of `endpoint`, as Neon gives one: with the role's password, through its pooler when `pooled`. */
const uri = (p: FakeNeonProject, endpoint: ApiEndpoint, pooled: boolean) => {
  const host = pooled ? endpoint.host.replace(/^(ep-[^.]+)/, "$1-pooler") : endpoint.host;
  return `postgresql://${ROLE}:${p.password}@${host}/${DATABASE}?sslmode=require`;
};

/** Neon's API as the fake answers it, from `state`. */
function fakeApi(state: FakeNeonState): NeonApi {
  const next = (prefix: string) => `${prefix}-${++state.seq}`;
  const projectOf = (id: string) => {
    const found = state.projects[id];
    if (!found) throw fail(404, `project ${id} not found`);
    return found;
  };
  const endpointOf = (projectId: string, id: string) => {
    const found = projectOf(projectId).endpoints[id];
    if (!found) throw fail(404, `endpoint ${id} not found`);
    return found;
  };
  /** A read-write compute on `branch`, where `p` runs, sized as the project's default. */
  const compute = (p: FakeNeonProject, branchId: string, limits: Limits) => {
    const id = next("ep-fake");
    const endpoint: ApiEndpoint = {
      id,
      host: `${id}.${p.project.region_id.replace(/^aws-/, "")}.aws.neon.tech`,
      branch_id: branchId,
      type: "read_write",
      current_state: "active",
      ...limits,
    };
    p.endpoints[id] = endpoint;
    return endpoint;
  };
  return {
    async createProject({ project: body }) {
      if (!(REGIONS as readonly string[]).includes(body.region_id)) {
        throw fail(400, `region ${body.region_id} is not supported`);
      }
      const id = next("fake-project");
      const project = { id, name: body.name, region_id: body.region_id, pg_version: body.pg_version ?? PG_VERSION };
      const branch = { id: next("br-fake"), name: "main", default: true };
      const made: FakeNeonProject = {
        project,
        branches: { [branch.id]: branch },
        endpoints: {},
        password: `fake-password-${state.seq}`,
      };
      state.projects[id] = made;
      const endpoint = compute(made, branch.id, body.default_endpoint_settings);
      return { project: { ...project }, branch: { ...branch }, endpoints: [{ ...endpoint }] };
    },
    getProject: async (id) => {
      const found = state.projects[id]?.project;
      return found && { ...found };
    },
    async updateProject(id, { project: body }) {
      projectOf(id).project.name = body.name;
    },
    async deleteProject(id) {
      delete state.projects[id];
    },
    branches: async (projectId) => Object.values(projectOf(projectId).branches).map((b) => ({ ...b })),
    endpoints: async (projectId) => Object.values(projectOf(projectId).endpoints).map((e) => ({ ...e })),
    async updateEndpoint(projectId, endpointId, { endpoint: limits }) {
      Object.assign(endpointOf(projectId, endpointId), limits);
    },
    async connectionUri({ projectId, branch_id, pooled }) {
      const p = projectOf(projectId);
      const branch = branch_id ?? Object.values(p.branches).find((b) => b.default)!.id;
      const endpoint = Object.values(p.endpoints).find((e) => e.branch_id === branch && e.type === "read_write");
      if (!endpoint) throw fail(404, `branch ${branch} has no read-write endpoint`);
      return uri(p, endpoint, pooled);
    },
    async createBranch(projectId, { branch: body }) {
      const p = projectOf(projectId);
      const branch = { id: next("br-fake"), default: false, ...body };
      p.branches[branch.id] = branch;
      const main = Object.values(p.endpoints).find((e) => p.branches[e.branch_id]?.default);
      const { autoscaling_limit_min_cu, autoscaling_limit_max_cu } = main ?? limitsOf();
      const endpoint = compute(p, branch.id, { autoscaling_limit_min_cu, autoscaling_limit_max_cu });
      return { branch: { ...branch }, connection_uris: [{ connection_uri: uri(p, endpoint, false) }] };
    },
    async deleteBranch(projectId, branchId) {
      const p = projectOf(projectId);
      if (p.branches[branchId]?.default) throw fail(400, `branch ${branchId} is the project's default branch`);
      delete p.branches[branchId];
      for (const [id, e] of Object.entries(p.endpoints)) if (e.branch_id === branchId) delete p.endpoints[id];
    },
    async suspendEndpoint(projectId, endpointId) {
      const endpoint = endpointOf(projectId, endpointId);
      endpoint.current_state = "idle";
      return { ...endpoint };
    },
    async startEndpoint(projectId, endpointId) {
      const endpoint = endpointOf(projectId, endpointId);
      endpoint.current_state = "active";
      return { ...endpoint };
    },
  };
}

/**
 * An in-memory Neon for tests, as Neon's API answers: projects in `state.projects`, each made with
 * a default branch (`main`) and its read-write compute, active at once; ids made in order
 * (`fake-project-1`, `br-fake-2`, `ep-fake-3`), each URL `postgresql://neondb_owner:…@<host>/neondb`.
 * A suspend makes a compute `idle`, a start `active`. It refuses what Neon refuses: a region it
 * has not, an object it has not (404), a project's default branch deleted.
 */
export function fakeNeon(options: FakeOptions = {}) {
  return defineFake(
    neonOps,
    {
      initial: (): FakeNeonState => ({ seq: 0, projects: {} }),
      ops: (state) => neonOperations(fakeApi(state)),
    },
    options,
  );
}
