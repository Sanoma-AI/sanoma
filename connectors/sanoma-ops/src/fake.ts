import { DriverError, retryableStatus, type WakeupRegistration } from "@sanoma-ai/workflows";
import { INSTANCE_TOKEN, instanceUrl } from "@sanoma-ai/workflows/wakeup-service";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { sanomaOpsOps } from "./connector.ts";
import { type Instance, UNREGISTERED, type WakeupApi, wakeupOps } from "./wakeup.ts";

/** An instance of the fake wakeup service, as it keeps one. */
export interface FakeWakeupInstance extends Instance {
  token: string;
}

export interface FakeSanomaOpsState extends Record<string, unknown> {
  seq: number;
  instances: Record<string, FakeWakeupInstance>;
}

/** How long the fake waits before it sends a wake again that the host did not answer. */
const RETRY_MS = 250;
/** setTimeout's longest delay: a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

const fail = (status: number, message: string) =>
  new DriverError(`sanomaOps: ${message}`, { retryable: retryableStatus(status), status });

/** The URL as the service keeps it (`instanceUrl`, its own rule), or the service's 400. */
function checkedUrl(value: string): string {
  const checked = instanceUrl(value);
  if ("error" in checked) throw fail(400, checked.error);
  return checked.url;
}

/**
 * An in-memory wakeup service for tests, as `sanoma wakeup` answers: instances in
 * `state.instances`, ids made in order (UUID-shaped), each named by the token it was posted with
 * (the call's `SANOMA_WAKEUP_TOKEN`), so posting it again moves it. `register` takes only the instance's own
 * token, and only a newer generation; it then sends `GET {host}/wake?generation=N` at `at`, again
 * every 250 ms until the host answers 2xx. `fire()` sends every armed wake now; `close()` (and
 * `reset()`) disarms them.
 */
export function fakeSanomaOps(options: FakeOptions = {}) {
  /** The wake each instance waits to send, by its id. */
  const armed = new Map<
    string,
    { generation: number; at: number; url: string; timeout?: NodeJS.Timeout; sending?: boolean }
  >();
  const disarm = (id: string) => {
    clearTimeout(armed.get(id)?.timeout);
    armed.delete(id);
  };
  /** Sends `id`'s armed wake once it is due, while it is still the one armed, until the host answers. */
  const send = async (id: string, pending = armed.get(id)) => {
    // One request at a time: the one in flight sends again if it is not answered.
    if (!pending || armed.get(id) !== pending || pending.sending) return;
    const due = pending.at - Date.now();
    if (due > 0) {
      pending.timeout = setTimeout(() => void send(id, pending), Math.min(due, MAX_DELAY_MS)).unref();
      return;
    }
    pending.sending = true;
    const answered = await fetch(`${pending.url}/wake?generation=${pending.generation}`).then(
      (res) => res.ok,
      () => false,
    );
    pending.sending = false;
    if (armed.get(id) !== pending) return;
    if (answered) armed.delete(id);
    else pending.timeout = setTimeout(() => void send(id, pending), RETRY_MS).unref();
  };

  const api = (state: FakeSanomaOpsState): WakeupApi => ({
    async put(url, token) {
      const checked = checkedUrl(url);
      if (!INSTANCE_TOKEN.test(token)) throw fail(400, "token must be an instance's token");
      const mine = Object.values(state.instances).find((i) => i.token === token);
      if (mine) {
        // The same instance, moved: its wake there forgotten.
        if (mine.url !== checked) {
          Object.assign(mine, { url: checked, ...UNREGISTERED });
          disarm(mine.id);
        }
        return { id: mine.id };
      }
      const id = `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
      state.instances[id] = { id, url: checked, ...UNREGISTERED, token };
      return { id };
    },
    async get(id) {
      const found = state.instances[id];
      if (!found) return undefined;
      const { token: _, ...shown } = found;
      return shown;
    },
    async remove(id) {
      delete state.instances[id];
      disarm(id);
    },
    async wake({ at, generation }: WakeupRegistration, token) {
      // The token names the instance.
      const mine = Object.values(state.instances).find((i) => i.token === token);
      if (!mine) throw fail(401, "the token is no instance's");
      const { id } = mine;
      // An older or equal generation changes nothing: callers retry, at least once each.
      if (generation <= mine.generation) return;
      Object.assign(mine, { at: new Date(at).toISOString(), generation, lastError: null });
      disarm(id);
      armed.set(id, { generation, at: Date.parse(at), url: mine.url });
      void send(id);
    },
  });

  const fake = defineFake(
    sanomaOpsOps,
    {
      initial: (): FakeSanomaOpsState => ({ seq: 0, instances: {} }),
      ops: (state) => ({ wakeup: wakeupOps(() => api(state)) }),
    },
    options,
  );
  const close = () => {
    for (const id of armed.keys()) disarm(id);
  };
  const { reset } = fake;
  return Object.assign(fake, {
    /** Sends every armed wake now, whatever its `at`; resolves once the hosts answered them, or fails after 60 s. */
    async fire() {
      const fired = [...armed].map(([id, pending]) => {
        clearTimeout(pending.timeout);
        pending.at = 0;
        void send(id, pending);
        return pending;
      });
      const until = Date.now() + 60_000;
      while (fired.some((p) => [...armed.values()].includes(p))) {
        if (Date.now() > until) throw new Error("sanomaOps fake: a fired wake was not answered in 60 s");
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    /** Disarms every armed wake. */
    close,
    /** Empties the state and disarms every armed wake. */
    reset() {
      close();
      reset();
    },
  });
}
