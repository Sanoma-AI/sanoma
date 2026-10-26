import { type CallContext, DriverError, type PlanAction, type WakeupRegistration } from "@sanoma-ai/workflows";
import { instanceUrl, mintInstanceToken, WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import { z } from "zod";

// The wakeup type's operations over the wakeup service (`WakeupApi`): the driver's calls it over
// HTTP, the fake's answers from its state. Both go through `wakeupOps`, so they plan, post the
// token and refuse alike.

/** An instance as the service shows it (`GET /wakeup/instances/{id}`): the fields read here. */
export const instanceSchema = z.object({
  id: z.string(),
  url: z.string(),
  at: z.string().nullable(),
  generation: z.number(),
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
  /** `PUT /wakeup/wake { at, generation }` with the instance's token, which names the instance. */
  wake(registration: WakeupRegistration, token: string): Promise<void>;
}

/** What the service holds of an instance that registered no wake: a new one's, and one moved to a new URL. */
export const UNREGISTERED = { at: null, generation: 0, lastError: null } as const;

/** The driver's own refusal, before or instead of a call: never retried. */
export const refused = (message: string, vendorCode?: string) =>
  new DriverError(`sanomaOps: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/** A wakeup's state: the service's instance, its URL as `host`. */
const stateOf = ({ id, url, at, generation, lastError }: Instance) => ({ id, host: url, at, generation, lastError });
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
export function wakeupOps(api: () => WakeupApi) {
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
    return {
      action: "update",
      planned: { ...state, ...planned, ...UNREGISTERED },
      state,
      ...none,
    };
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
        throw refused(`wakeup.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
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
          `wakeup.register: ${WAKEUP_TOKEN} is not set: connect sanoma-ops in /setup, then apply the wakeup`,
        );
      await api().wake(registration, token);
      return {};
    },
  };
}
