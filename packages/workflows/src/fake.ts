import {
  type Connector,
  defineDriver,
  type Driver,
  type DriverFn,
  type DriverImpl,
  DriverError,
  type OpIdOf,
  type Specs,
  withSetup,
} from "./op.ts";

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
 * Builds a fake vendor for a connector, for tests and demos. `ops` implements the operations
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

/**
 * `connector` set up with this fake instead of the one its package attaches, for a test or a demo
 * that seeds or reads the fake its runs call: live runs call its driver, and sandbox runs call it
 * too, since its maker gives this very one. A driver swap alone is `withSetup(connector, { driver })`,
 * which keeps the package's fake, so each sandbox run has one of its own. The operations are the
 * same.
 */
export function withFake<C extends Connector<any, any>>(connector: C, fake: Fake<any, any>): C {
  return withSetup(connector, { driver: () => fake.driver, fake: () => fake });
}
