import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { DriverError, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";
import { supabaseTf } from "./connector.ts";
import { apiError, type ManagementApi, withManagement } from "./management.ts";

export interface SupabaseDriverOptions {
  /**
   * The provider bridge to read through. Default: the process's `defaultBridge()`, started on the
   * first call from `SANOMA_BRIDGE_BIN`. One per tenant: it holds the token once configured.
   */
  bridge?: ProviderClient;
  /** How long a Management API request may take, in milliseconds. Default 30 seconds. */
  timeoutMs?: number;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  SUPABASE_ACCESS_TOKEN: z
    .string()
    .min(1)
    .describe("a personal access token that can read, create and delete the projects the data files declare"),
});

const API = "https://api.supabase.com";

const accessToken = () => {
  const value = process.env.SUPABASE_ACCESS_TOKEN;
  if (!value) throw new DriverError("supabase: SUPABASE_ACCESS_TOKEN is not set", { retryable: false });
  return value;
};

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
    return (await res.json()) as T;
  };
  return {
    projects: () => get("/v1/projects"),
    pooler: (ref) => get(`${project(ref)}/config/database/pooler`),
    health: (ref, services) => get(`${project(ref)}/health?services=${services.map(encodeURIComponent).join(",")}`),
  };
}

/**
 * Supabase's projects through the `supabase/supabase` OpenTofu provider on `bridge` (the default
 * bridge when none is given), and the pooler, health and database URL through the Management API,
 * with the access token in `SUPABASE_ACCESS_TOKEN`, read on every call. The provider is
 * configured on the first call, and again when the token changes or the provider has exited.
 */
export function supabaseDriver({ bridge = defaultBridge(), timeoutMs = 30_000 }: SupabaseDriverOptions = {}) {
  const provider = supabaseTf.driver(bridge, () => ({ access_token: accessToken(), endpoint: null }));
  const driver = withManagement(provider, () => managementApi(accessToken(), timeoutMs));
  return Object.freeze({ ...driver, env });
}
