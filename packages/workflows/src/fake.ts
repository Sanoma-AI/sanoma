import {
  type Connector,
  defineDriver,
  type Driver,
  type DriverFn,
  type DriverImpl,
  DriverError,
  type OpIdOf,
  type Specs,
} from "./op.ts";
import { fail, type Instance, UNREGISTERED, type WakeupApi, wakeupCalls } from "./wakeup-driver.ts";
import { INSTANCE_TOKEN, instanceUrl } from "./wakeup-service.ts";
import { wakeupOps } from "./wakeup-type.ts";
import type { ConnectionRef } from "./connection.ts";

/*
 * Fake vendors for tests, at `@sanoma-ai/workflows/fake`. Kept off the main entry so the
 * runtime bundle carries no test tooling, and so the lint can refuse it in workflow files.
 */

/** One call a fake received. */
export interface FakeCall {
  op: string;
  input: unknown;
  /** When the call arrived, as an ISO timestamp. */
  at: string;
  idempotencyKey: string;
  attempt: number;
  connection?: string;
}

/** A factory per named account: state, faults and idempotent replies never cross connections. */
export function connectionFakes<F extends Fake<unknown>>(make: () => F) {
  const first = make();
  const { vendor } = first.driver;
  let unused: F | undefined = first;
  const accounts = new Map<string, { fake: F; identity?: string }>();
  const calls: FakeCall[] = [];
  const account = (ref: ConnectionRef): F => {
    if (ref.vendor !== vendor || !ref.$connection.startsWith(`${vendor}/`))
      throw new Error(`fake ${vendor}: select a connection of this connector`);
    let entry = accounts.get(ref.$connection);
    if (!entry) {
      entry = { fake: unused ?? make() };
      unused = undefined;
      accounts.set(ref.$connection, entry);
    }
    return entry.fake;
  };
  const ops: Record<string, DriverFn> = {};
  for (const key of Object.keys(first.driver.ops)) {
    ops[key] = async (input, call) => {
      const selected = call.connection;
      if (!selected || selected.vendor !== vendor)
        throw new DriverError(`fake ${vendor}: select a named connection`, { retryable: false });
      const ref = { vendor, $connection: selected.id };
      account(ref);
      let entry = accounts.get(selected.id)!;
      // Rebinding to another vendor account gets fresh state. Rotation within an account does not.
      if (entry.identity !== undefined && entry.identity !== selected.account) {
        entry = { fake: make() };
        accounts.set(selected.id, entry);
      }
      entry.identity = selected.account;
      calls.push({
        op: `${vendor}.${key}`,
        input: structuredClone(input),
        at: new Date().toISOString(),
        idempotencyKey: call.idempotencyKey,
        attempt: call.attempt,
        connection: selected.id,
      });
      return entry.fake.driver.ops[key]!(input, call);
    };
  }
  return {
    driver: { vendor, ops } satisfies Driver,
    account,
    calls,
    reset() {
      for (const entry of accounts.values()) entry.fake.reset();
      calls.length = 0;
    },
  };
}

export interface FakeOptions {
  /** Log calls into this array instead of the fake's own, so several fakes share one ordered log. */
  calls?: FakeCall[];
}

/** An in-memory vendor for tests, with faults a test can inject into its next calls. */
export interface Fake<T, Id extends string = string> {
  driver: Driver;
  /** The vendor's state. */
  readonly state: T;
  /** Empties the state, the remembered replies and the pending faults, and drops this fake's calls from the log. */
  reset(): void;
  /** Changes the vendor's state as someone at the vendor would, so the next call sees it. */
  update(change: (state: T) => void): void;
  /** Every call received, in order, including failed ones and repeats of an idempotency key. */
  calls: FakeCall[];
  /** The next call to `opId` throws `err` (default: a retryable `DriverError`) and changes nothing. */
  failNext(opId: Id, err?: unknown): void;
  /** The next call to `opId` takes effect, then throws once, as if its reply was lost. */
  loseReply(opId: Id): void;
  /** The next call to `opId` throws a retryable `DriverError` with status 429 and changes nothing. */
  rateLimit(opId: Id): void;
  /** The next call to `opId` waits, before it takes effect, until the returned function is called. */
  hold(opId: Id): () => void;
}

/**
 * A fake that holds its vendor's objects by resource type (`repository`) and import id, as
 * `@sanoma-ai/bridge`'s `tfFake` does, with fields in the resource's shape: what a scenario's
 * resource steps seed on a sandbox run's own fake. `put` sets the fields over the object there, or
 * makes one; `remove` deletes it, and is nothing when there is none.
 */
export interface ResourceFake {
  override(type: string, id: string, fields: Record<string, unknown>): void;
  put(type: string, id: string, fields: Record<string, unknown>): void;
  remove(type: string, id: string): void;
}

type Fault =
  | { kind: "fail"; error: unknown }
  | { kind: "loseReply" }
  | { kind: "rateLimit" }
  | { kind: "hold"; released: Promise<void> };

/**
 * Builds a fake vendor for a connector, for tests and sandbox runs. `ops` implements the operations
 * against `state`, typed by the connector as `defineDriver` does. The fake adds what a real
 * vendor does around them: a repeated idempotency key gets the first reply and changes
 * nothing. A test can make the next call fail, lose its reply, hit a rate limit or wait.
 */
export function defineFake<V extends string, S extends Specs, T extends Record<string, unknown>>(
  connector: Connector<V, S>,
  definition: { initial: () => T; ops: (state: T) => DriverImpl<S> },
  options: FakeOptions = {},
): Fake<T, OpIdOf<V, S>> {
  const state = definition.initial();
  let replies: Record<string, unknown> = {};
  // Replaced in place, so the object `ops` closes over stays the live state.
  const replace = (next: T) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  };

  const inner = defineDriver(connector, definition.ops(state));
  const { vendor } = inner;
  const calls = options.calls ?? [];
  const faults = new Map<string, Fault[]>();
  const inject = (opId: string, fault: Fault) => {
    if (!opId.startsWith(`${vendor}.`) || !Object.hasOwn(inner.ops, opId.slice(vendor.length + 1))) {
      throw new Error(`fake ${vendor}: no operation ${opId}`);
    }
    faults.set(opId, [...(faults.get(opId) ?? []), fault]);
  };

  const ops: Record<string, DriverFn> = {};
  for (const [key, fn] of Object.entries(inner.ops)) {
    const opId = `${vendor}.${key}`;
    ops[key] = async (input, call) => {
      const { idempotencyKey, attempt } = call;
      calls.push({ op: opId, input, at: new Date().toISOString(), idempotencyKey, attempt });
      const fault = faults.get(opId)?.shift();
      if (fault?.kind === "fail") throw fault.error;
      if (fault?.kind === "rateLimit") {
        throw new DriverError(`fake ${vendor}: ${opId} was rate limited`, {
          retryable: true,
          status: 429,
          vendorCode: "rate_limited",
        });
      }
      if (fault?.kind === "hold") await fault.released;
      if (Object.hasOwn(replies, idempotencyKey)) return structuredClone(replies[idempotencyKey]);
      const output = await fn(input, call);
      replies[idempotencyKey] = output;
      if (fault?.kind === "loseReply") {
        throw new DriverError(`fake ${vendor}: the reply to ${opId} was lost`, { retryable: true });
      }
      return output;
    };
  }

  return {
    driver: { vendor, ops },
    state,
    update(change) {
      change(state);
    },
    reset() {
      replace(definition.initial());
      replies = {};
      faults.clear();
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]?.op.startsWith(`${vendor}.`)) calls.splice(i, 1);
    },
    calls,
    failNext(opId, err) {
      const error = err ?? new DriverError(`fake ${vendor}: ${opId} failed`, { retryable: true });
      inject(opId, { kind: "fail", error });
    },
    loseReply(opId) {
      inject(opId, { kind: "loseReply" });
    },
    rateLimit(opId) {
      inject(opId, { kind: "rateLimit" });
    },
    hold(opId) {
      let release!: () => void;
      inject(opId, { kind: "hold", released: new Promise<void>((resolve) => (release = resolve)) });
      return release;
    },
  };
}

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
