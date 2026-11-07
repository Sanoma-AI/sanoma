import { z } from "zod";
import { type CallContext, defineDriver, DriverError, retryableStatus } from "./op.ts";
import type { PlanAction } from "./resource.ts";
import { defineSteps } from "./steps.ts";
import type { WakeupRegistration } from "./wakeup.ts";
import { instanceUrl, mintInstanceToken, WAKEUP_TOKEN } from "./wakeup-service.ts";
import { wakeupOps } from "./wakeup-type.ts";

// `sanoma.wakeup`'s operations over a wakeup service (`WakeupApi`): the driver's call it over
// HTTP (plain `fetch`, the service has no SDK), the fake's (`fakeSanomaWakeup` in `fake.ts`)
// answer from its state. Both go through `wakeupCalls`, so they plan, post the token and refuse
// alike. `config.ts` puts the two together as the built-in `sanomaWakeup`.

/** An instance as the service shows it (`GET /wakeup/instances/{id}`): the fields read here. */
const instanceSchema = z.object({
  id: z.string(),
  url: z.string(),
  at: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type Instance = z.output<typeof instanceSchema>;

/** The wakeup service, as the operations use it. Each call fails with a `DriverError`. */
export interface WakeupApi {
  /**
   * `POST /wakeup/instances { url, token }` with the account's token: the instance the token
   * names, made, or moved to `url` when the account registered it before.
   */
  put(url: string, token: string): Promise<{ id: string }>;
  /** `GET /wakeup/instances/{id}` with the account's token; undefined when there is none (404). */
  get(id: string): Promise<Instance | undefined>;
  /** `DELETE /wakeup/instances/{id}` with the account's token; nothing when there is none. */
  remove(id: string): Promise<void>;
  /** `PUT /wakeup/wake { at }` with the instance's token, which names the instance. */
  wake(registration: WakeupRegistration, token: string): Promise<void>;
}

/** What the service holds of an instance that registered no wake: a new one's, and one moved to a new URL. */
export const UNREGISTERED = { at: null, lastError: null } as const;

export const fail = (message: string, status: number) =>
  new DriverError(`sanoma.wakeup: ${message}`, { retryable: retryableStatus(status), status });

/** The driver's own refusal, before or instead of a call: never retried. */
const refused = (message: string, vendorCode?: string) =>
  new DriverError(`sanoma.wakeup: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/** A wakeup's state: the service's instance, its URL as `host`. */
const stateOf = ({ id, url, at, lastError }: Instance) => ({ id, host: url, at, lastError });
type State = ReturnType<typeof stateOf>;

/** What `plan` finds: the action, what it would leave, and the state it planned from. */
interface Planned {
  action: PlanAction;
  planned?: Record<string, unknown>;
  state?: State;
  unknown: string[];
  replace: string[];
}

/** A URL as the service keeps it (`instanceUrl`, the service's own rule), or as given when the service would refuse it. */
const normalUrl = (url: unknown) => {
  const checked = instanceUrl(url);
  return "url" in checked ? checked.url : String(url);
};

/**
 * The wakeup type's operations and `wakeup.register` over `api()`, made on each call. The
 * instance's token, `SANOMA_WAKEUP_TOKEN`, names the instance: `create` and `update` both post it
 * with the host's URL (minted and stored first when none is, as for a data file written by hand),
 * so a new host is the same instance moved, never a replace; `register` sends it.
 */
export function wakeupCalls(api: () => WakeupApi) {
  const read = async ({ id }: { id: string }) => {
    const found = await api().get(id);
    return found ? { id, gone: false, state: stateOf(found) } : { id, gone: true };
  };
  /**
   * The instance the stored token names, at the desired host: made or moved, its state as a new
   * one's (a repeat after a lost reply keeps the wake the service holds, which the next read shows).
   */
  const put = async (desired: Record<string, unknown>, { secrets }: CallContext) => {
    const host = normalUrl(desired.host);
    const token = await secrets.ensure(WAKEUP_TOKEN, mintInstanceToken);
    const { id } = await api().put(host, token);
    const state: State = { id, host, ...UNREGISTERED };
    return { id, state };
  };
  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    const state = id === undefined ? undefined : (await read({ id })).state;
    const none = { unknown: [], replace: [] };
    if (!desired) return { action: state ? "delete" : "none", state, ...none };
    const planned = { host: normalUrl(desired.host) };
    if (!state) return { action: "create", planned, unknown: ["id"], replace: [] };
    if (planned.host === state.host) return { action: "none", planned: state, state, ...none };
    // A move forgets the wake registered at the old URL, as the service does.
    return { action: "update", planned: { ...state, ...planned, ...UNREGISTERED }, state, ...none };
  };
  return {
    import: read,
    read,
    plan: async (input: { id?: string; desired?: Record<string, unknown> }) => {
      const { state: _, ...out } = await plan(input);
      return out;
    },
    create: ({ desired }: { desired: Record<string, unknown> }, call: CallContext) => put(desired, call),
    update: async (
      {
        id,
        desired,
        expect,
      }: { id: string; desired: Record<string, unknown>; expect?: { action: PlanAction; replace: string[] } },
      call: CallContext,
    ) => {
      const fresh = await plan({ id, desired });
      if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
        throw refused(`update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
      }
      if (fresh.state && fresh.action === "none") return { id, state: fresh.state };
      return put(desired, call);
    },
    delete: async ({ id }: { id: string }) => {
      await api().remove(id);
      return { id, gone: true as const };
    },
    register: async (registration: WakeupRegistration, { secrets }: CallContext) => {
      const token = await secrets.get(WAKEUP_TOKEN);
      if (!token)
        throw refused(
          `register: ${WAKEUP_TOKEN} is not set: connect a wakeup service in /setup, then apply the wakeup`,
        );
      await api().wake(registration, token);
      return {};
    },
  };
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  SANOMA_WAKEUP_URL: z.url().optional().describe("the wakeup service's URL: Sanoma's, or your own `sanoma wakeup`"),
  SANOMA_WAKEUP_ACCOUNT_TOKEN: z
    .string()
    .startsWith("swa_", "an account's token starts swa_")
    .optional()
    .describe("an account's token at the wakeup service (swa_…), which creates and deletes the instances"),
  // No check of its form: a host's own wakeup (Cloudflare's alarm) takes this variable too, and
  // the service refuses a token that is not an instance's.
  [WAKEUP_TOKEN]: z
    .string()
    .optional()
    .describe(
      "this instance's token at the wakeup service (swi_…), which /setup mints and the wakeup's create registers",
    ),
});

/** The variable `name`, read when an operation is called, or the driver's refusal. */
function required(
  values: Record<string, string | undefined>,
  name: "SANOMA_WAKEUP_URL" | "SANOMA_WAKEUP_ACCOUNT_TOKEN",
): string {
  const value = values[name];
  if (!value) throw refused(`${name} is not set (${env.shape[name].description})`);
  return value;
}

const Posted = z.object({ id: z.string() });
/** The service's error body. */
const Problem = z.object({ error: z.string() });

const instance = (id: string) => `/wakeup/instances/${encodeURIComponent(id)}`;

/** The service at `SANOMA_WAKEUP_URL`, read when an operation is called: each request's failure a `DriverError`. */
function serviceApi(timeoutMs: number, values: Record<string, string | undefined>): WakeupApi {
  const base = required(values, "SANOMA_WAKEUP_URL").replace(/\/+$/, "");
  if (!URL.canParse(base)) throw refused("SANOMA_WAKEUP_URL is not a URL");
  const account = () => required(values, "SANOMA_WAKEUP_ACCOUNT_TOKEN");
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
      throw new DriverError(`sanoma.wakeup: ${where}: ${why}`, { retryable: true, cause });
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
    if (status < 200 || status >= 300)
      throw fail(`${where}: ${Problem.safeParse(json).data?.error ?? `HTTP ${status}`}`, status);
    if (!reply) return undefined;
    const parsed = reply.safeParse(json);
    if (!parsed.success) {
      throw new DriverError(
        `sanoma.wakeup: ${where}: the reply is not a wakeup service's; is SANOMA_WAKEUP_URL right?`,
        {
          retryable: false,
          status,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  };
  return {
    put: async (url, token) => {
      try {
        return (await send("POST", "/wakeup/instances", account(), { reply: Posted, body: { url, token } }))!;
      } catch (error) {
        // Another account's instance's token: the advice is the company's, so it is here, not the service's.
        if (!(error instanceof DriverError) || error.status !== 409) throw error;
        throw new DriverError(
          `${error.message}: a new account needs a new instance token (store the new account's token in /setup, which mints one)`,
          { retryable: false, status: 409, cause: error },
        );
      }
    },
    get: (id) => send("GET", instance(id), account(), { reply: instanceSchema, absent: true }),
    async remove(id) {
      await send("DELETE", instance(id), account(), { absent: true });
    },
    async wake({ at }, token) {
      await send("PUT", "/wakeup/wake", token, { body: { at } });
    },
  };
}

/**
 * The real wakeup service at `SANOMA_WAKEUP_URL`: instances created, read and deleted with
 * `SANOMA_WAKEUP_ACCOUNT_TOKEN`, each named by its `SANOMA_WAKEUP_TOKEN` (which `create` and
 * `register` send). `timeoutMs` is how long one request may take: 10 s by default.
 */
export function sanomaWakeupDriver({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}) {
  const call = async (name: keyof ReturnType<typeof wakeupCalls>, input: unknown, context: CallContext) => {
    const values = Object.fromEntries(
      await Promise.all(Object.keys(env.shape).map(async (key) => [key, await context.secrets.get(key)])),
    );
    const methods = wakeupCalls(() => serviceApi(timeoutMs, values));
    return (methods[name] as (input: unknown, context: CallContext) => Promise<unknown>)(input, context);
  };
  const methods = Object.fromEntries(
    ["import", "read", "plan", "create", "update", "delete", "register"].map((name) => [
      name,
      (input: unknown, context: CallContext) => call(name as keyof ReturnType<typeof wakeupCalls>, input, context),
    ]),
  );
  return defineDriver(wakeupOps, { wakeup: methods } as never, { env });
}

/** The wakeup's step for Gherkin tests: an instance at the service before the run, named `wakeup` (`$wakeup.id`). */
export const wakeupSteps = defineSteps("sanoma", ({ given }) => {
  given("a sanoma wakeup for {string}", (host: string) => ({
    op: wakeupOps.wakeup.create,
    input: { desired: { host } },
    as: "wakeup",
  }));
});
