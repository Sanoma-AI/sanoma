import { type CallContext, DriverError, type PlanAction, type WakeupRegistration } from "@sanoma-ai/workflows";

// The wakeup type's operations over the wakeup service (`WakeupApi`): the driver's calls it over
// HTTP, the fake's answers from its state. Both go through `wakeupOps`, so they plan, store the
// token and refuse alike.

/** An instance as the service shows it (`GET /wakeup/instances/{id}`): the fields read here. */
export interface Instance {
  id: string;
  url: string;
  at: string | null;
  generation: number;
  lastError: string | null;
}

/** The wakeup service, as the operations use it. Each call fails with a `DriverError`. */
export interface WakeupApi {
  /** `POST /wakeup/instances { url }` with the account's token: the new instance's id and its token, shown once. */
  create(url: string): Promise<{ id: string; token: string }>;
  /** `GET /wakeup/instances/{id}` with the account's token; undefined when there is none (404). */
  get(id: string): Promise<Instance | undefined>;
  /** `DELETE /wakeup/instances/{id}` with the account's token; nothing when there is none. */
  remove(id: string): Promise<void>;
  /** `PUT /wakeup/instances/{id}/wake { at, generation }` with the instance's token. */
  wake(registration: WakeupRegistration, token: string): Promise<void>;
}

/** The secret the instance's token is stored as, by `create`, and read from, by `register`. */
export const WAKEUP_TOKEN = "SANOMA_WAKEUP_TOKEN";

/** Why a new instance's token cannot be stored: the secret holds another's, which the store cannot replace. */
const STALE = `${WAKEUP_TOKEN} holds another instance's token: clear it on the connector page, then apply again`;

const refused = (message: string, vendorCode?: string) =>
  new DriverError(`sanomaOps: ${message}`, { retryable: false, ...(vendorCode && { vendorCode }) });

/** A wakeup's state: the service's instance, its URL as `host`. */
const stateOf = ({ id, url, at, generation, lastError }: Instance) => ({ id, host: url, at, generation, lastError });
type State = ReturnType<typeof stateOf>;

/** A URL as the service keeps it: without a trailing slash. */
const normalUrl = (url: unknown) => String(url).replace(/\/+$/, "");

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
    if ((await secrets.ensure(WAKEUP_TOKEN, () => made.token)) !== made.token) {
      // An instance no one can register with is removed again; the stored token stays.
      await service.remove(made.id).catch(() => undefined);
      throw refused(`wakeup.create: ${STALE}`, "stale");
    }
    const state: State = { id: made.id, host, at: null, generation: 0, lastError: null };
    return { id: made.id, state };
  };
  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }) => {
    const state = id === undefined ? undefined : (await read({ id })).state;
    const none = { unknown: [] as string[], replace: [] as string[] };
    if (!desired) return { action: (state ? "delete" : "none") as PlanAction, state, ...none };
    const planned = { host: normalUrl(desired.host) };
    if (!state) return { action: "create" as PlanAction, planned, unknown: ["id"], replace: [] };
    if (planned.host === state.host) return { action: "none" as PlanAction, planned: state, state, ...none };
    return { action: "replace" as PlanAction, planned, state, unknown: ["id"], replace: ["host"] };
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
      // A new instance has a new token: refused before the old instance is deleted.
      if (await call.secrets.get(WAKEUP_TOKEN)) throw refused(`wakeup.update: ${STALE}`, "stale");
      if (fresh.state) await api().remove(id);
      return create(desired, call);
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
