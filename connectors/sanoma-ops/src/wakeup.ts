import { type CallContext, DriverError, type PlanAction, type WakeupRegistration } from "@sanoma-ai/workflows";
import { instanceUrl } from "@sanoma-ai/workflows/wakeup-service";
import { z } from "zod";

// The wakeup type's operations over the wakeup service (`WakeupApi`): the driver's calls it over
// HTTP, the fake's answers from its state. Both go through `wakeupOps`, so they plan, store the
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
  /** `POST /wakeup/instances { url }` with the account's token: the new instance's id and its token, shown once. */
  create(url: string): Promise<{ id: string; token: string }>;
  /** `GET /wakeup/instances/{id}` with the account's token; undefined when there is none (404). */
  get(id: string): Promise<Instance | undefined>;
  /** `DELETE /wakeup/instances/{id}` with the account's token; nothing when there is none. */
  remove(id: string): Promise<void>;
  /** `PUT /wakeup/wake { at, generation }` with the instance's token, which names the instance. */
  wake(registration: WakeupRegistration, token: string): Promise<void>;
}

/** The secret the instance's token is stored as, by `create`, and read from, by `register`. */
export const WAKEUP_TOKEN = "SANOMA_WAKEUP_TOKEN";

/** Why a new instance's token cannot be stored: the secret holds another's, which the store cannot replace. */
const STALE = `${WAKEUP_TOKEN} holds another instance's token: clear it on the connector page, then apply again`;

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
 * The wakeup type's operations and `wakeup.register` over `api()`, made on each call: `create`
 * stores the instance's token as `SANOMA_WAKEUP_TOKEN` (never returned), and `register` reads it
 * there; a new host is a new instance, refused while a token is stored.
 */
export function wakeupOps(api: () => WakeupApi) {
  const read = async ({ id }: { id: string }) => {
    const found = await api().get(id);
    return found ? { id, gone: false, state: stateOf(found) } : { id, gone: true };
  };
  const create = async (desired: Record<string, unknown>, { secrets }: CallContext) => {
    const service = api();
    const host = normalUrl(desired.host);
    const made = await service.create(host);
    // An instance no one can register with (its token not stored) is removed again.
    const removeMade = () => service.remove(made.id).catch(() => undefined);
    const stored = await secrets
      .ensure(WAKEUP_TOKEN, () => made.token)
      .catch(async (err: unknown) => {
        await removeMade();
        throw err;
      });
    if (stored !== made.token) {
      await removeMade();
      throw refused(`wakeup.create: ${STALE}`, "stale");
    }
    const state: State = { id: made.id, host, at: null, generation: 0, lastError: null };
    return { id: made.id, state };
  };
  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    const state = id === undefined ? undefined : (await read({ id })).state;
    const none = { unknown: [], replace: [] };
    if (!desired) return { action: state ? "delete" : "none", state, ...none };
    const planned = { host: normalUrl(desired.host) };
    if (!state) return { action: "create", planned, unknown: ["id"], replace: [] };
    if (planned.host === state.host) return { action: "none", planned: state, state, ...none };
    return { action: "replace", planned, state, unknown: ["id"], replace: ["host"] };
  };
  return {
    import: read,
    read,
    plan: async (input: { id?: string; desired?: Record<string, unknown> }) => {
      const { state: _, ...out } = await plan(input);
      return out;
    },
    create: ({ desired }: { desired: Record<string, unknown> }, call: CallContext) => create(desired, call),
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
      // A new instance has a new token: refused before anything changes.
      if (await call.secrets.get(WAKEUP_TOKEN)) throw refused(`wakeup.update: ${STALE}`, "stale");
      // The new one first, so a create that fails leaves the old one in place; the old one, its
      // wake never registered again, is removed after, and one left behind wakes nothing new.
      const made = await create(desired, call);
      if (fresh.state)
        await api()
          .remove(id)
          .catch(() => undefined);
      return made;
    },
    delete: async ({ id }: { id: string }) => {
      await api().remove(id);
      return { id, gone: true as const };
    },
    register: async (registration: WakeupRegistration, { secrets }: CallContext) => {
      const token = await secrets.get(WAKEUP_TOKEN);
      if (!token) throw refused(`wakeup.register: ${WAKEUP_TOKEN} is not set: apply the wakeup to store it`);
      await api().wake(registration, token);
      return {};
    },
  };
}
