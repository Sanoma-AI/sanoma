import { defineDriver, DriverError, errorMessage } from "@sanoma-ai/workflows";
import type { Api, BranchCreateRequest } from "@neondatabase/api-client";
import { z } from "zod";
import { neonOps } from "./connector.ts";
import { type NeonApi, neonOperations, refused, retryable } from "./operations.ts";

export interface NeonDriverOptions {
  /** How long one request to Neon may take, in milliseconds. Default 30 000. */
  timeoutMs?: number;
}

/** The environment variable the driver reads, on every call. */
const env = z.object({
  NEON_API_KEY: z
    .string()
    .min(1)
    .describe("an organization API key, from console.neon.tech, Organization settings, API keys"),
});

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

/** Neon's API through the SDK with the key in `NEON_API_KEY`, read on each call: each failure a `DriverError`. */
function sdkApi(timeoutMs: number): NeonApi {
  /** The client for the last key read, made again only when `NEON_API_KEY` changes. */
  let client: { key: string; api: Api<unknown> } | undefined;
  const connect = async () => {
    const key = process.env.NEON_API_KEY;
    if (!key) throw refused(`NEON_API_KEY is not set (${env.shape.NEON_API_KEY.description})`);
    const { createApiClient } = await sdk();
    if (client?.key !== key) client = { key, api: createApiClient({ apiKey: key, timeout: timeoutMs }) };
    return client.api;
  };
  /**
   * One request: its reply's `data`, or `undefined` for Neon's 404 where `absent` says it means
   * no such object; any other failure a `DriverError`.
   */
  async function send<T>(where: string, request: (api: Api<unknown>) => Promise<{ data: T }>): Promise<T>;
  async function send<T>(
    where: string,
    request: (api: Api<unknown>) => Promise<{ data: T }>,
    absent: true,
  ): Promise<T | undefined>;
  async function send<T>(where: string, request: (api: Api<unknown>) => Promise<{ data: T }>, absent = false) {
    const api = await connect();
    try {
      return (await request(api)).data;
    } catch (error) {
      if (absent && isAbsent(error)) return undefined;
      throw failure(where, error, timeoutMs);
    }
  }
  return {
    createProject: (body) => send("POST /projects", (api) => api.createProject(body)),
    getProject: async (id) => (await send(`GET /projects/${id}`, (api) => api.getProject(id), true))?.project,
    async updateProject(id, body) {
      await send(`PATCH /projects/${id}`, (api) => api.updateProject(id, body));
    },
    async deleteProject(id) {
      await send(`DELETE /projects/${id}`, (api) => api.deleteProject(id), true);
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
      await send(
        `DELETE /projects/${projectId}/branches/${branchId}`,
        (api) => api.deleteProjectBranch({ projectId, branchId }),
        true,
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
 * the organization API key in `NEON_API_KEY`, read on every call. See the README.
 */
export function neonDriver(options: NeonDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const api = sdkApi(timeoutMs);
  return defineDriver(
    neonOps,
    neonOperations(() => api),
    { env },
  );
}
