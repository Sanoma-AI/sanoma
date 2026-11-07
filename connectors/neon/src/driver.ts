import { authenticationCredentials, defineDriver, DriverError, errorMessage } from "sanoma/workflows";
import type { NeonApiErrorKind, NeonErrorUnion } from "@neon/sdk";
import type { Client, RawResult } from "@neon/sdk/raw";
import { z } from "zod";
import { neonOps } from "./connector.ts";
import { type NeonApi, neonOperations, retryable } from "./operations.ts";
import { neonApiKey } from "./authentication.ts";
import { loadSdk, neonClient, type Raw } from "./sdk.ts";

export interface NeonDriverOptions {
  /** How long one request to Neon may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/** Neon's error body: `{ code, message }`. */
const Problem = z.object({ code: z.string().optional(), message: z.string() });

/**
 * An error carrying Neon's answer, its HTTP status and a body it could read: every kind of
 * `NeonApiError`, whatever kinds the SDK adds. A body read that failed (a parse error, or the
 * deadline while reading) leaves an `Error` in `body`: no answer was read.
 */
type Answered = Extract<NeonErrorUnion, { kind: NeonApiErrorKind }>;
const answered = (error: NeonErrorUnion): error is Answered =>
  typeof (error as { status?: unknown }).status === "number" && !((error as { body?: unknown }).body instanceof Error);

/**
 * The `DriverError` for a request that failed, retryable as `retryable` says. No `cause`: the
 * SDK's error keeps its request and response, the key among the request's headers.
 */
function failure(where: string, error: NeonErrorUnion): DriverError {
  if (error.kind === "network") {
    // No answer: the request may or may not have reached Neon.
    // Not the SDK's reason: a malformed header's error echoes its value, the key.
    return new DriverError(`neon: ${where}: the request failed`, { retryable: true });
  }
  if ("status" in error && typeof error.status === "number" && !answered(error)) {
    // Neon answered, but its reply could not be read: as good as no reply.
    return new DriverError(`neon: ${where}: the reply could not be read`, { retryable: true });
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

/** One raw call, given the module, the invocation's client and its deadline. */
type Request<T> = (raw: Raw, options: { client: Client; signal: AbortSignal }) => Promise<RawResult<T>>;

/** One invocation's SDK client: no key, client or session is shared with another call. */
function sdkApi(timeoutMs: number, key: string): NeonApi {
  let loaded: Promise<{ raw: Raw; client: Client }> | undefined;
  const connect = () => (loaded ??= loadSdk().then((raw) => ({ raw, client: neonClient(raw, key) })));
  /**
   * One request under its own deadline. Once the deadline has passed, a failure with no answer read
   * is the timeout; an answer Neon gave in time still stands.
   */
  const attempt = async <T>(where: string, request: Request<T>): Promise<RawResult<T>> => {
    const { raw, client } = await connect();
    const signal = AbortSignal.timeout(timeoutMs);
    const result = await request(raw, { client, signal });
    if (result.error !== undefined && signal.aborted && !answered(result.error)) {
      throw new DriverError(`neon: ${where}: no reply in ${timeoutMs} ms`, { retryable: true });
    }
    return result;
  };
  /** One request: its reply's `data`, every failure a `DriverError`. */
  const send = async <T>(where: string, request: Request<T>): Promise<T> => {
    const result = await attempt(where, request);
    if (result.error !== undefined) throw failure(where, result.error);
    return result.data;
  };
  /** One request whose 404 means no such object: `undefined` then. */
  const sendOrAbsent = async <T>(where: string, request: Request<T>): Promise<T | undefined> => {
    const result = await attempt(where, request);
    if (result.error === undefined) return result.data;
    if (isAbsent(result.error)) return undefined;
    throw failure(where, result.error);
  };
  return {
    listProjects: (query) => send("GET /projects", (raw, o) => raw.listProjects({ ...o, query })),
    createProject: (body) => send("POST /projects", (raw, o) => raw.createProject({ ...o, body })),
    getProject: async (id) =>
      (await sendOrAbsent(`GET /projects/${id}`, (raw, o) => raw.getProject({ ...o, path: { project_id: id } })))
        ?.project,
    async updateProject(id, body) {
      await send(`PATCH /projects/${id}`, (raw, o) => raw.updateProject({ ...o, path: { project_id: id }, body }));
    },
    async deleteProject(id) {
      await sendOrAbsent(`DELETE /projects/${id}`, (raw, o) => raw.deleteProject({ ...o, path: { project_id: id } }));
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
      await sendOrAbsent(`DELETE /projects/${projectId}/branches/${branchId}`, (raw, o) =>
        raw.deleteProjectBranch({ ...o, path: { project_id: projectId, branch_id: branchId } }),
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
