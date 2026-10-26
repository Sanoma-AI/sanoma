import { defineDriver, DriverError, retryableStatus } from "@sanoma-ai/workflows";
import { z } from "zod";
import { sanomaOpsOps } from "./connector.ts";
import { type Instance, instanceSchema, refused, WAKEUP_TOKEN, type WakeupApi, wakeupOps } from "./wakeup.ts";

/*
 * The wakeup service's driver, over its routes (`@sanoma-ai/workflows/wakeup-service`). The
 * service has no SDK or OpenAPI spec: plain `fetch`, with a timeout on each request.
 */

/**
 * Sanoma's hosted wakeup service, where the driver calls unless `SANOMA_OPS_URL` is set: a
 * placeholder until sanoma-ops serves the service at its own URL.
 */
export const HOSTED_URL = "https://sanoma.ai";

export interface SanomaOpsDriverOptions {
  /** How long one request to the service may take, in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  SANOMA_OPS_URL: z
    .url()
    .optional()
    .describe(`the wakeup service's URL; Sanoma's hosted one (${HOSTED_URL}) when unset`),
  SANOMA_OPS_TOKEN: z
    .string()
    .startsWith("swa_", "an account's token starts swa_")
    .optional()
    .describe("an account's token at the wakeup service (swa_…), which creates and deletes the instances"),
  [WAKEUP_TOKEN]: z
    .string()
    .startsWith("swi_", "an instance's token starts swi_")
    .optional()
    .describe("this instance's token at the wakeup service (swi_…), which apply stores when it creates the wakeup"),
});

const Created = z.object({ id: z.string(), token: z.string() });
/** The service's error body. */
const Problem = z.object({ error: z.string() });

const instance = (id: string) => `/wakeup/instances/${encodeURIComponent(id)}`;

/** The account's token, read when an operation is called. */
function accountToken(): string {
  const token = process.env.SANOMA_OPS_TOKEN;
  if (!token) throw refused(`SANOMA_OPS_TOKEN is not set (${env.shape.SANOMA_OPS_TOKEN.description})`);
  return token;
}

/** The service at `SANOMA_OPS_URL`, read when an operation is called: each request's failure a `DriverError`. */
function serviceApi(timeoutMs: number): WakeupApi {
  const base = (process.env.SANOMA_OPS_URL || HOSTED_URL).replace(/\/+$/, "");
  if (!URL.canParse(base)) throw refused("SANOMA_OPS_URL is not a URL");
  /**
   * One request: its reply parsed by `reply` (none: not read), a 404 `undefined` where `absent`
   * says it means no such instance, and any other answer but a 2xx a `DriverError`.
   */
  const send = async <T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    token: string,
    { reply, body, absent = false }: { reply?: z.ZodType<T>; body?: unknown; absent?: boolean } = {},
  ): Promise<T | undefined> => {
    const where = `${method} ${path}`;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect is no answer of the service's, and would carry the token elsewhere.
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      text = await res.text();
    } catch (cause) {
      // No answer: the request may or may not have reached the service.
      const why = (cause as Error).name === "TimeoutError" ? `no reply in ${timeoutMs} ms` : "the request failed";
      throw new DriverError(`sanomaOps: ${where}: ${why}`, { retryable: true, cause });
    }
    const { status } = res;
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy's HTML page, say: no body to read.
    }
    // The service's own 404 (its `{ error }`), not another server's at that URL.
    if (status === 404 && absent && Problem.safeParse(json).success) return undefined;
    if (status < 200 || status >= 300) {
      const message = Problem.safeParse(json).data?.error ?? `HTTP ${status}`;
      throw new DriverError(`sanomaOps: ${where}: ${message}`, { retryable: retryableStatus(status), status });
    }
    if (!reply) return undefined;
    const parsed = reply.safeParse(json);
    if (!parsed.success) {
      throw new DriverError(`sanomaOps: ${where}: the reply is not the wakeup service's; is SANOMA_OPS_URL right?`, {
        retryable: false,
        status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  };
  return {
    create: async (url) =>
      (await send("POST", "/wakeup/instances", accountToken(), { reply: Created, body: { url } }))!,
    get: (id): Promise<Instance | undefined> =>
      send("GET", instance(id), accountToken(), { reply: instanceSchema, absent: true }),
    async remove(id) {
      await send("DELETE", instance(id), accountToken(), { absent: true });
    },
    async wake({ id, at, generation }, token) {
      await send("PUT", `${instance(id)}/wake`, token, { body: { at, generation } });
    },
  };
}

/**
 * The real wakeup service at `SANOMA_OPS_URL` (Sanoma's hosted one by default): instances
 * created, read and deleted with `SANOMA_OPS_TOKEN`, wakes registered with `SANOMA_WAKEUP_TOKEN`,
 * which `create` stores. See the README.
 */
export function sanomaOpsDriver(options: SanomaOpsDriverOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return defineDriver(sanomaOpsOps, { wakeup: wakeupOps(() => serviceApi(timeoutMs)) }, { env });
}
