import { defineFake, type FakeOptions } from "./fake.ts";
import { fail, type Instance, UNREGISTERED, type WakeupApi, wakeupCalls } from "./wakeup-driver.ts";
import { INSTANCE_TOKEN, instanceUrl } from "./wakeup-service.ts";
import { wakeupOps } from "./wakeup-type.ts";

// The built-in `sanoma.wakeup`'s fake: an in-memory wakeup service that calls the host's `/wake`.

/** An instance of the fake wakeup service, as it keeps one. */
interface FakeInstance extends Instance {
  token: string;
}

interface FakeWakeupState extends Record<string, unknown> {
  seq: number;
  instances: Record<string, FakeInstance>;
}

/** How long the fake waits before it sends a wake again that the host did not answer. */
const RETRY_MS = 250;
/** setTimeout's longest delay: a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The URL as the service keeps it (`instanceUrl`, its own rule), or the service's 400. */
function checkedUrl(value: string): string {
  const checked = instanceUrl(value);
  if ("error" in checked) throw fail(checked.error, 400);
  return checked.url;
}

/**
 * An in-memory wakeup service for tests, as `sanoma wakeup` answers: instances in
 * `state.instances`, ids made in order (UUID-shaped), each named by the token it was posted with
 * (the call's `SANOMA_WAKEUP_TOKEN`), so posting it again moves it. `register` takes only the
 * instance's own token and replaces the wake it had; it then sends `GET {host}/wake` at `at`,
 * again every 250 ms until the host answers 2xx. `fire()` sends every armed wake now; `close()`
 * (and `reset()`) disarms them.
 */
export function fakeSanomaWakeup(options: FakeOptions = {}) {
  /** The wake each instance waits to send, by its id. */
  const armed = new Map<string, { at: number; url: string; timeout?: NodeJS.Timeout; sending?: boolean }>();
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
    const answered = await fetch(`${pending.url}/wake`).then(
      (res) => res.ok,
      () => false,
    );
    pending.sending = false;
    if (armed.get(id) !== pending) return;
    if (answered) armed.delete(id);
    else pending.timeout = setTimeout(() => void send(id, pending), RETRY_MS).unref();
  };

  const api = (state: FakeWakeupState): WakeupApi => ({
    async put(url, token) {
      const checked = checkedUrl(url);
      if (!INSTANCE_TOKEN.test(token)) throw fail("token must be an instance's token", 400);
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
    async wake({ at }, token) {
      // The token names the instance.
      const mine = Object.values(state.instances).find((i) => i.token === token);
      if (!mine) throw fail("the token is no instance's", 401);
      Object.assign(mine, { at: new Date(at).toISOString(), lastError: null });
      disarm(mine.id);
      armed.set(mine.id, { at: Date.parse(at), url: mine.url });
      void send(mine.id);
    },
  });

  const fake = defineFake(
    wakeupOps,
    {
      initial: (): FakeWakeupState => ({ seq: 0, instances: {} }),
      ops: (state) => ({ wakeup: wakeupCalls(() => api(state)) }),
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
        if (Date.now() > until) throw new Error("sanoma.wakeup fake: a fired wake was not answered in 60 s");
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
