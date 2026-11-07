import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { authenticationCredentials, type CallContext, DriverError, retryableStatus } from "@sanoma-ai/workflows";
import { API, supabaseAccessToken, supabaseOAuth } from "./authentication.ts";
import { supabaseTf } from "./connector.ts";
import { apiError, type ManagementApi, withManagement } from "./management.ts";

export interface SupabaseDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call (`startBridge`'s binary). Each call's token is a provider session of its own.
   */
  bridge?: ProviderClient;
  /** How long a Management API request may take, in milliseconds. Default 30 seconds. */
  timeoutMs?: number;
}

/** The methods the driver takes a token from: an OAuth grant's, or a pasted personal access token. */
const METHODS = ["oauth", "accessToken"];

/** The selected connection's token for this call: never the environment. */
const accessToken = (call: CallContext) =>
  call.authentication?.method === "oauth"
    ? authenticationCredentials("oauth", supabaseOAuth, call).accessToken
    : authenticationCredentials("accessToken", supabaseAccessToken, call).accessToken;

const project = (ref: string) => `/v1/projects/${encodeURIComponent(ref)}`;

/** The Management API with `token`: each request a GET, its failures `DriverError`s, retryable as the runtime's rule says. */
function managementApi(token: string, timeoutMs: number): ManagementApi {
  const get = async <T>(path: string): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new DriverError(`supabase: GET ${path} failed: ${(e as Error).message}`, { retryable: true, cause: e });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text.slice(0, 200);
      try {
        message = String((JSON.parse(text) as { message?: unknown }).message ?? message);
      } catch {}
      throw apiError(path, res.status, message || res.statusText, retryableStatus(res.status));
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new DriverError(`supabase: GET ${path} answered ${res.status} without JSON`, { retryable: true, cause: e });
    }
  };
  return {
    organizations: () => get("/v1/organizations"),
    projects: () => get("/v1/projects"),
    pooler: (ref) => get(`${project(ref)}/config/database/pooler`),
    health: (ref, services) => get(`${project(ref)}/health?services=${services.map(encodeURIComponent).join(",")}`),
  };
}

/**
 * Supabase's projects through the `supabase/supabase` OpenTofu provider on `bridge` (the default
 * bridge when none is given), and the organizations, pooler, health and database URL through the
 * Management API, each call with the selected connection's token: an OAuth grant's (`oauth`) or a
 * personal access token (`accessToken`). The provider is configured per token, in a session of
 * its own.
 */
export function supabaseDriver({ bridge = defaultBridge(), timeoutMs = 30_000 }: SupabaseDriverOptions = {}) {
  const provider = supabaseTf.driver(
    bridge,
    (call) => ({ access_token: accessToken(call), endpoint: null }),
    undefined,
    undefined,
    { authentication: METHODS },
  );
  return withManagement(provider, (call) => managementApi(accessToken(call), timeoutMs));
}
