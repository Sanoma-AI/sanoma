import { authenticationCredentials, defineDriver, DriverError, errorMessage } from "@sanoma-ai/workflows";
import type { NeonErrorUnion } from "@neon/sdk";
import type { Client, RawResult } from "@neon/sdk/raw";
import { z } from "zod";
import { neonOps } from "./connector.ts";
import { type NeonApi, neonOperations, retryable } from "./operations.ts";
import { neonApiKey } from "./authentication.ts";

export interface NeonDriverOptions {
  /** How long one request to Neon may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/**
 * `@neon/sdk`'s raw layer, loaded at the first call: a worker that never calls Neon (or the app
 * listing the connector) need not load it. The raw functions are Neon's endpoints one to one,
 * with none of the ergonomic client's retries or readiness waits: retrying is the runtime's.
 */
const sdk = () => import("@neon/sdk/raw");

/** Neon's error body: `{ code, message }`. */
const Problem = z.object({ code: z.string().optional(), message: z.string() });

/** The kinds of SDK error that carry Neon's answer: a status and its body. */
const ANSWERED = new Set(["api", "not_found", "auth", "rate_limit"]);
type Answered = Extract<NeonErrorUnion, { kind: "api" | "not_found" | "auth" | "rate_limit" }>;
const answered = (error: NeonErrorUnion): error is Answered => ANSWERED.has(error.kind);

/**
 * The `DriverError` for a request that failed, retryable as `retryable` says. No `cause`: the
 * SDK's error keeps its request and response, the key among the request's headers.
 */
function failure(where: string, error: NeonErrorUnion, timeoutMs: number): DriverError {
  if (error.kind === "aborted") {
    // The request's own deadline ran out: it may or may not have reached Neon.
    return new DriverError(`neon: ${where}: no reply in ${timeoutMs} ms`, { retryable: true });
  }
  if (error.kind === "network") {
    return new DriverError(`neon: ${where}: the request failed`, { retryable: true });
  }
  if (!answered(error)) {
    return new DriverError(`neon: ${where}: ${errorMessage(error)}`, { retryable: false });
  }
  const { status } = error;
  const problem = Problem.safeParse(error.body).data;
  return new DriverError(`neon: ${where}: ${problem?.message ?? `HTTP ${status}`}`, {
    retryable: retryable(status),
    status,
    ...(problem?.code && { vendorCode: problem.code }),
  });
}

/** A 404 with Neon's own error body: no such object, rather than another server's page. */
const isAbsent = (error: NeonErrorUnion) => error.kind === "not_found" && Problem.safeParse(error.body).success;

type Raw = typeof import("@neon/sdk/raw");
/** One raw call, given the module, the invocation's client and its deadline. */
type Request<T> = (raw: Raw, options: { client: Client; signal: AbortSignal }) => Promise<RawResult<T>>;

/** One invocation's SDK client: no key, client or session is shared with another call. */
function sdkApi(timeoutMs: number, key: string): NeonApi {
  let loaded: Promise<{ raw: Raw; client: Client }> | undefined;
  const connect = () =>
    (loaded ??= sdk().then((raw) => ({
      raw,
      client: raw.createClient(raw.createConfig({ auth: () => key, baseUrl: "https://console.neon.tech/api/v2" })),
    })));
  /** One request: its reply's `data`, or `undefined` for an absent object when `absent` allows it. */
  const call = async <T>(where: string, request: Request<T>, absent = false): Promise<T | undefined> => {
    const { raw, client } = await connect();
    const { data, error } = await request(raw, { client, signal: AbortSignal.timeout(timeoutMs) });
    if (error === undefined) return data;
    if (absent && isAbsent(error)) return undefined;
    throw failure(where, error, timeoutMs);
  };
  /** One request whose reply has a body. */
  const send = async <T>(where: string, request: Request<T>): Promise<T> => (await call(where, request)) as T;
  return {
    listProjects: (query) => send("GET /projects", (raw, o) => raw.listProjects({ ...o, query })),
    createProject: (body) => send("POST /projects", (raw, o) => raw.createProject({ ...o, body })),
    getProject: async (id) =>
      (await call(`GET /projects/${id}`, (raw, o) => raw.getProject({ ...o, path: { project_id: id } }), true))
        ?.project,
    async updateProject(id, body) {
      await send(`PATCH /projects/${id}`, (raw, o) => raw.updateProject({ ...o, path: { project_id: id }, body }));
    },
    async deleteProject(id) {
      await call(`DELETE /projects/${id}`, (raw, o) => raw.deleteProject({ ...o, path: { project_id: id } }), true);
    },
    branches: async (projectId) =>
      (
        await send(
          `GET /projects/${projectId}/branches`, // Neon's most per page: a project's preview branches must not push the default one off it.
          (raw, o) => raw.listProjectBranches({ ...o, path: { project_id: projectId }, query: { limit: 10_000 } }),
        )
      ).branches,
    endpoints: async (projectId) =>
      (
        await send(`GET /projects/${projectId}/endpoints`, (raw, o) =>
          raw.listProjectEndpoints({ ...o, path: { project_id: projectId } }),
        )
      ).endpoints,
    async updateEndpoint(projectId, endpointId, body) {
      await send(`PATCH /projects/${projectId}/endpoints/${endpointId}`, (raw, o) =>
        raw.updateProjectEndpoint({ ...o, path: { project_id: projectId, endpoint_id: endpointId }, body }),
      );
    },
    connectionUri: async ({ projectId, ...query }) =>
      (
        await send(`GET /projects/${projectId}/connection_uri`, (raw, o) =>
          raw.getConnectionUri({ ...o, path: { project_id: projectId }, query }),
        )
      ).uri,
    createBranch: (projectId, body) =>
      send(`POST /projects/${projectId}/branches`, (raw, o) =>
        raw.createProjectBranch({ ...o, path: { project_id: projectId }, body }),
      ),
    async deleteBranch(projectId, branchId) {
      await call(
        `DELETE /projects/${projectId}/branches/${branchId}`,
        (raw, o) => raw.deleteProjectBranch({ ...o, path: { project_id: projectId, branch_id: branchId } }),
        true,
      );
    },
    suspendEndpoint: async (projectId, endpointId) =>
      (
        await send(`POST /projects/${projectId}/endpoints/${endpointId}/suspend`, (raw, o) =>
          raw.suspendProjectEndpoint({ ...o, path: { project_id: projectId, endpoint_id: endpointId } }),
        )
      ).endpoint,
    startEndpoint: async (projectId, endpointId) =>
      (
        await send(`POST /projects/${projectId}/endpoints/${endpointId}/start`, (raw, o) =>
          raw.startProjectEndpoint({ ...o, path: { project_id: projectId, endpoint_id: endpointId } }),
        )
      ).endpoint,
  };
}

/**
 * Neon's projects, branches and computes through `@neon/sdk`, Neon's own SDK, with
 * the selected named connection's organization key. See the README.
 */
export function neonDriver(options: NeonDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return defineDriver(
    neonOps,
    (call) => neonOperations(sdkApi(timeoutMs, authenticationCredentials("apiKey", neonApiKey, call).apiKey)),
    { authentication: ["apiKey"] },
  );
}
