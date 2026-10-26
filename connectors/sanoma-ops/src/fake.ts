import { DriverError, type WakeupRegistration } from "@sanoma-ai/workflows";
import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import { sanomaOpsOps } from "./connector.ts";
import { type Instance, type WakeupApi, wakeupOps } from "./wakeup.ts";

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
  new DriverError(`sanomaOps: ${message}`, { retryable: status >= 500, status });

/** An http(s) URL with no user, password, query or fragment, as the service takes one; else a 400. */
function checkedUrl(value: string): string {
  const url = !/[?#]/.test(value) && URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw fail(400, "url must be an http(s) URL with no user, password, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * An in-memory wakeup service for tests, as `sanoma wakeup` answers: instances in
 * `state.instances`, ids made in order (UUID-shaped), each with its token (`swi_…`), which
 * `create` stores as the call's `SANOMA_WAKEUP_TOKEN`. `register` takes only the instance's own
 * token, and only a newer generation; it then sends `GET {host}/wake?generation=N` at `at`, again
 * every 250 ms until the host answers 2xx. `fire()` sends every armed wake now; `close()` (and
 * `reset()`) disarms them.
 */
export function fakeSanomaOps(options: FakeOptions = {}) {
  /** The wake each instance waits to send, by its id. */
  const armed = new Map<string, { generation: number; at: number; url: string; timeout?: NodeJS.Timeout }>();
  const disarm = (id: string) => {
    clearTimeout(armed.get(id)?.timeout);
    armed.delete(id);
  };
  /** Sends `id`'s armed wake once it is due, while it is still the one armed, until the host answers. */
  const send = async (id: string, pending = armed.get(id)) => {
    if (!pending || armed.get(id) !== pending) return;
    const due = pending.at - Date.now();
    if (due > 0) {
      pending.timeout = setTimeout(() => void send(id, pending), Math.min(due, MAX_DELAY_MS)).unref();
      return;
    }
    const answered = await fetch(`${pending.url}/wake?generation=${pending.generation}`).then(
      (res) => res.ok,
      () => false,
    );
    if (armed.get(id) !== pending) return;
    if (answered) armed.delete(id);
    else pending.timeout = setTimeout(() => void send(id, pending), RETRY_MS).unref();
  };

  const api = (state: FakeSanomaOpsState): WakeupApi => ({
    async create(url) {
      const n = ++state.seq;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const token = `swi_fake${String(n).padStart(4, "0")}`;
      state.instances[id] = { id, url: checkedUrl(url), at: null, generation: 0, lastError: null, token };
      return { id, token };
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
    async wake({ id, at, generation }: WakeupRegistration, token) {
      const mine = Object.values(state.instances).find((i) => i.token === token);
      if (!mine) throw fail(401, "the token is no instance's");
      if (mine.id !== id) throw fail(403, "the token is another instance's");
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
    for (const pending of armed.values()) clearTimeout(pending.timeout);
    armed.clear();
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
