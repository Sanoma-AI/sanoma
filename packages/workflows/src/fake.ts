import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/*
 * Fake vendors for tests, at `@sanoma/workflows/fake`. Kept off the main entry so the
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
  /**
   * Keep the state, and the reply given for each idempotency key, in this JSON file, so they
   * survive a restart and another process can read them. The call log stays in memory.
   */
  file?: string;
  /** Log calls into this array instead of the fake's own, so several fakes share one ordered log. */
  calls?: FakeCall[];
}

/** An in-memory vendor for tests, with faults a test can inject into its next calls. */
export interface Fake<T, Id extends string = string> {
  driver: Driver;
  /** The vendor's state, re-read from the file first when there is one. */
  readonly state: T;
  /** Empties the state, the remembered replies and the pending faults, and drops this fake's calls from the log. */
  reset(): void;
  /**
   * Changes the vendor's state as someone at the vendor would: re-reads it from the file first,
   * applies `change`, and saves it, so the next call (in any process) sees it.
   */
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
  const { file } = options;
  const state = definition.initial();
  let replies: Record<string, unknown> = {};
  // Replaced in place, so the object `ops` closes over stays the live state.
  const replace = (next: T) => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  };
  const refresh = () => {
    if (!file || !existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as { state: T; replies: Record<string, unknown> };
    replace(saved.state);
    replies = saved.replies;
  };
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ state, replies }, null, 2));
  };
  refresh();

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
      // With a file, another process may have changed the state while this call waited.
      refresh();
      if (Object.hasOwn(replies, idempotencyKey)) return structuredClone(replies[idempotencyKey]);
      let output: unknown;
      try {
        output = await fn(input, call);
        replies[idempotencyKey] = output;
      } finally {
        save();
      }
      if (fault?.kind === "loseReply") {
        throw new DriverError(`fake ${vendor}: the reply to ${opId} was lost`, { retryable: true });
      }
      return output;
    };
  }

  return {
    driver: { vendor, ops },
    get state() {
      refresh();
      return state;
    },
    update(change) {
      refresh();
      change(state);
      save();
    },
    reset() {
      replace(definition.initial());
      replies = {};
      faults.clear();
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]?.op.startsWith(`${vendor}.`)) calls.splice(i, 1);
      save();
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
