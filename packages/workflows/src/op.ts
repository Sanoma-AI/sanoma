import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * What an operation does to the outside world. It sets the badge a reviewer
 * sees and, later, the Cedar action the call is checked against.
 */
export type Effect = "read" | "write" | "publish" | "send" | "money" | "access";

export interface OpSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  effect: Effect;
  input: I;
  output: O;
  /** Safe to retry: the vendor dedupes repeated calls. Otherwise a failed call stops the run. */
  idempotent?: boolean;
  description?: string;
}

/** One vendor operation, such as `ghost.post.publish`. Declares the contract only; drivers implement it. */
export interface Op<V extends string = string, R extends string = string, N extends string = string, I = any, O = any> {
  readonly kind: "op";
  readonly id: `${V}.${R}.${N}`;
  readonly vendor: V;
  readonly resource: R;
  readonly name: N;
  readonly effect: Effect;
  readonly idempotent: boolean;
  readonly description?: string;
  readonly input: z.ZodType<any, I>;
  readonly output: z.ZodType<O>;
}

export type Specs = Record<string, Record<string, OpSpec>>;

export type Connector<V extends string, S extends Specs> = {
  readonly [R in keyof S & string]: {
    readonly [N in keyof S[R] & string]: Op<V, R, N, z.input<S[R][N]["input"]>, z.output<S[R][N]["output"]>>;
  };
};

/** Declares a vendor's operations, grouped by resource: `defineConnector("ghost", { post: { create: {...} } })`. */
export function defineConnector<const V extends string, const S extends Specs>(vendor: V, specs: S): Connector<V, S> {
  const out: Record<string, Record<string, Op>> = {};
  for (const [resource, ops] of Object.entries(specs)) {
    out[resource] = {};
    for (const [name, spec] of Object.entries(ops)) {
      out[resource][name] = Object.freeze({
        kind: "op",
        id: `${vendor}.${resource}.${name}`,
        vendor,
        resource,
        name,
        effect: spec.effect,
        idempotent: spec.idempotent ?? false,
        description: spec.description,
        input: spec.input,
        output: spec.output,
      } satisfies Op);
    }
  }
  return out as Connector<V, S>;
}

/**
 * What the runtime tells a driver about the call it is making. `idempotencyKey` is the same
 * on every replay and retry of one call (`<runId>:<seq>`), so a driver can hand it to the
 * vendor, or dedupe on it, and a crash between the vendor's reply and the checkpoint does
 * not repeat the side effect.
 */
export interface CallContext {
  idempotencyKey: string;
  runId: string;
  opId: string;
  /** 1 on the first try; retries count up (idempotent operations only). */
  attempt: number;
}

export type DriverFn<I = any, O = unknown> = (input: I, call: CallContext) => Promise<O>;

/**
 * A vendor's answer that the driver understood. `retryable` tells the runtime whether to try
 * again (an idempotent operation on a timeout or a 5xx) or to stop (a 4xx). `status` and
 * `vendorCode` keep what the vendor said, so the ledger and the UI can show it.
 */
export class DriverError extends Error {
  readonly code = "driver_failed" as const;
  readonly retryable: boolean;
  readonly status?: number;
  readonly vendorCode?: string;

  constructor(message: string, options: { retryable: boolean; status?: number; vendorCode?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DriverError";
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.vendorCode !== undefined) this.vendorCode = options.vendorCode;
  }
}

/**
 * Implements a vendor's operations, keyed `"resource.name"`. A driver reads its credentials
 * when it is called (from the environment or a secret store), never from the config file.
 */
export interface Driver {
  vendor: string;
  ops: Record<string, DriverFn>;
}

export function isOp(x: unknown): x is Op {
  return typeof x === "object" && x !== null && (x as Op).kind === "op";
}

/**
 * What a driver for a connector must implement: every operation, by resource and name. Each
 * function gets the input as the operation's schema parses it and returns what its output
 * schema accepts.
 */
export type DriverImpl<S extends Specs> = {
  [R in keyof S & string]: {
    [N in keyof S[R] & string]: DriverFn<z.output<S[R][N]["input"]>, z.input<S[R][N]["output"]>>;
  };
};

/** The ids of a connector's operations, such as `"ghost.post.create" | "ghost.post.publish"`. */
export type OpIdOf<V extends string, S extends Specs> = {
  [R in keyof S & string]: { [N in keyof S[R] & string]: `${V}.${R}.${N}` }[keyof S[R] & string];
}[keyof S & string];

/**
 * Implements a connector's operations, typed by its schemas. A driver must be complete: an
 * operation the connector declares that `impl` leaves out, or one `impl` adds that the
 * connector doesn't declare, is refused here rather than when a run calls it.
 */
export function defineDriver<V extends string, S extends Specs>(
  connector: Connector<V, S>,
  impl: DriverImpl<S>,
): Driver {
  const declared = new Map<string, Op>();
  for (const resource of Object.values(connector as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(resource)) if (isOp(op)) declared.set(`${op.resource}.${op.name}`, op);
  }
  const vendor = declared.values().next().value?.vendor;
  if (vendor === undefined) throw new Error("defineDriver: the connector declares no operations");
  const ops: Record<string, DriverFn> = {};
  const extra: string[] = [];
  for (const [resource, fns] of Object.entries(impl as Record<string, Record<string, unknown>>)) {
    for (const [name, fn] of Object.entries(fns ?? {})) {
      const key = `${resource}.${name}`;
      if (!declared.has(key)) extra.push(`${vendor}.${key}`);
      else if (typeof fn === "function") ops[key] = fn as DriverFn;
    }
  }
  const missing = [...declared.keys()].filter((key) => !Object.hasOwn(ops, key)).map((key) => `${vendor}.${key}`);
  const problems = [
    ...(missing.length ? [`it does not implement ${missing.join(", ")}`] : []),
    ...(extra.length ? [`it implements ${extra.join(", ")}, which the connector does not declare`] : []),
  ];
  if (problems.length) throw new Error(`defineDriver("${vendor}"): ${problems.join("; ")}`);
  return { vendor, ops };
}

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
