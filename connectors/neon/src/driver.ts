import { authenticationCredentials, defineDriver, DriverError, errorMessage } from "@sanoma-ai/workflows";
import type { Api, BranchCreateRequest } from "@neondatabase/api-client";
import { z } from "zod";
import { neonOps } from "./connector.ts";
import { type NeonApi, neonOperations, retryable } from "./operations.ts";
import { neonApiKey } from "./authentication.ts";

export interface NeonDriverOptions {
  /** How long one request to Neon may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/**
 * `@neondatabase/api-client`, loaded at the first call: a worker that never calls Neon (or the
 * app listing the connector) need not load it and axios, and a test's replay, listening by then,
 * sees its requests.
 */
const sdk = () => import("@neondatabase/api-client");

/** What of an axios error is read here: the SDK throws axios's errors as they are. */
interface AxiosFailure {
  isAxiosError: true;
  code?: string;
  response?: { status: number; data?: unknown };
}

const isAxiosFailure = (error: unknown): error is AxiosFailure =>
  typeof error === "object" && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true;

/** Neon's error body: `{ code, message }`. */
const Problem = z.object({ code: z.string().optional(), message: z.string() });

/**
 * The `DriverError` for a request that failed, retryable as `retryable` says. No `cause`: an axios
 * error carries its request's headers, the key among them.
 */
function failure(where: string, error: unknown, timeoutMs: number): DriverError {
  if (!isAxiosFailure(error)) {
    return new DriverError(`neon: ${where}: ${errorMessage(error)}`, { retryable: false });
  }
  const { response, code } = error;
  if (!response) {
    const timedOut = code === "ECONNABORTED" || code === "ETIMEDOUT";
    // No answer: the request may or may not have reached Neon.
    return new DriverError(`neon: ${where}: ${timedOut ? `no reply in ${timeoutMs} ms` : "the request failed"}`, {
      retryable: true,
    });
  }
  const { status, data } = response;
  const problem = Problem.safeParse(data).data;
  return new DriverError(`neon: ${where}: ${problem?.message ?? `HTTP ${status}`}`, {
    retryable: retryable(status),
    status,
    ...(problem?.code && { vendorCode: problem.code }),
  });
}

/** A 404 with Neon's own error body: no such object, rather than another server's page. */
const isAbsent = (error: unknown) =>
  isAxiosFailure(error) && error.response?.status === 404 && Problem.safeParse(error.response.data).success;

/** One invocation's SDK client: no key, client or session is shared with another call. */
function sdkApi(timeoutMs: number, key: string): NeonApi {
  let client: Promise<Api<unknown>> | undefined;
  const connect = async () => {
    client ??= sdk().then(({ createApiClient }) => createApiClient({ apiKey: key, timeout: timeoutMs }));
    return client;
  };
  /** One request: its reply's `data`, every failure a `DriverError`. */
  const send = async <T>(where: string, request: (api: Api<unknown>) => Promise<{ data: T }>): Promise<T> => {
    const api = await connect();
    try {
      return (await request(api)).data;
    } catch (error) {
      throw failure(where, error, timeoutMs);
    }
  };
  /** One request whose 404 means no such object: `undefined` then. */
  const sendOrAbsent = <T>(where: string, request: (api: Api<unknown>) => Promise<{ data: T }>) =>
    send(where, (api) =>
      request(api).catch((error: unknown) => {
        if (isAbsent(error)) return { data: undefined };
        throw error;
      }),
    );
  return {
    createProject: (body) => send("POST /projects", (api) => api.createProject(body)),
    getProject: async (id) => (await sendOrAbsent(`GET /projects/${id}`, (api) => api.getProject(id)))?.project,
    async updateProject(id, body) {
      await send(`PATCH /projects/${id}`, (api) => api.updateProject(id, body));
    },
    async deleteProject(id) {
      await sendOrAbsent(`DELETE /projects/${id}`, (api) => api.deleteProject(id));
    },
    branches: async (projectId) =>
      (
        await send(
          `GET /projects/${projectId}/branches`, // Neon's most per page: a project's preview branches must not push the default one off it.
          (api) => api.listProjectBranches({ projectId, limit: 10_000 }),
        )
      ).branches,
    endpoints: async (projectId) =>
      (await send(`GET /projects/${projectId}/endpoints`, (api) => api.listProjectEndpoints(projectId))).endpoints,
    async updateEndpoint(projectId, endpointId, body) {
      await send(`PATCH /projects/${projectId}/endpoints/${endpointId}`, (api) =>
        api.updateProjectEndpoint(projectId, endpointId, body),
      );
    },
    connectionUri: async (query) =>
      (await send(`GET /projects/${query.projectId}/connection_uri`, (api) => api.getConnectionUri(query))).uri,
    createBranch: (projectId, body) =>
      send(
        `POST /projects/${projectId}/branches`, // `type` is the SDK's enum, whose values are these strings.
        (api) => api.createProjectBranch(projectId, body as BranchCreateRequest),
      ),
    async deleteBranch(projectId, branchId) {
      await sendOrAbsent(`DELETE /projects/${projectId}/branches/${branchId}`, (api) =>
        api.deleteProjectBranch({ projectId, branchId }),
      );
    },
    suspendEndpoint: async (projectId, endpointId) =>
      (
        await send(`POST /projects/${projectId}/endpoints/${endpointId}/suspend`, (api) =>
          api.suspendProjectEndpoint(projectId, endpointId),
        )
      ).endpoint,
    startEndpoint: async (projectId, endpointId) =>
      (
        await send(`POST /projects/${projectId}/endpoints/${endpointId}/start`, (api) =>
          api.startProjectEndpoint(projectId, endpointId),
        )
      ).endpoint,
  };
}

/**
 * Neon's projects, branches and computes through `@neondatabase/api-client`, Neon's own SDK, with
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
