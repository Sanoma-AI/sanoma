import {
  defineConnector,
  defineDriver,
  defineResource,
  type Driver,
  type PlanAction,
  DriverError,
  errorMessage,
  isEnded,
  type Resource,
  type SanomaClient,
  type WakeupRegistration,
  withSetup,
} from "@sanoma-ai/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import type { HostCheck, Wake } from "./host.ts";

// The conformance kit for the `Wakeup` contract: whether a wakeup type wakes a stopped host when
// the runtime asked it to, and only then. `checkWakeup` registers wakes through the type's
// register operation and watches the `/wake` requests the host answers. `fakeWakeup` is a
// wakeup in this process, for the kit's own tests and for building against the contract before
// a real wakeup lands.

/** A declared wakeup under test, the host it wakes, and how to drive it. */
export interface WakeupUnderTest {
  /** Its resource type, which meets the contract (`wakeup`). */
  type: Pick<Resource, "vendor" | "type" | "wakeup">;
  /** The host the wakeup is declared for, already applied and named by the wakeup's `host`. */
  host: {
    url: string;
    /** Stops the company's runtime as the host's lifetime does, the URL kept: the next request starts it. */
    stop(): Promise<void>;
    /** Each `GET /wake?generation=N` the host answered so far, across its stops, in order. */
    wakes(): readonly Wake[];
  };
  /** A client on the host's database, its config with `hostCheckWorkflows` (`@sanoma-ai/testing/host`). */
  client: SanomaClient;
  /** Calls the type's register operation (`wakeup.register`) through its driver. */
  register(registration: WakeupRegistration): Promise<void>;
  /**
   * The generation the checks count up from: they register `from + 1` to `from + 4`. Default 0;
   * against a wakeup that keeps the last generation it took, one above it.
   */
  from?: number;
  /** How long a check waits for a wake or a run. Default 60 s. */
  timeoutMs?: number;
}

/** One check's outcome. */
export type WakeupCheck = HostCheck;

const startedBy = { id: "wakeup-check" };

/**
 * Runs the conformance checks against a wakeup, in order, each on its own (one failing goes on
 * to the next): a registered wake arrives at the host after its `at`; a wake registered before
 * the host stops starts it, and a run queued while it was stopped drains; and a registration
 * replaced by a newer generation is never sent, nor one that arrives again after it (registration
 * is at least once). Each registers its own generation (`from` + 1, + 2, then + 3 and + 4) and
 * reads only the wakes the host answered since it began.
 */
export async function checkWakeup(w: WakeupUnderTest): Promise<WakeupCheck[]> {
  const { type, host, client, from = 0, timeoutMs = 60_000 } = w;
  if (!type.wakeup) {
    throw new Error(`${type.vendor}.${type.type} does not meet the Wakeup contract: it has no wakeup`);
  }
  const results: WakeupCheck[] = [];
  const check = async (name: string, run: (begun: Date) => Promise<void>) => {
    try {
      await run(new Date());
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: errorMessage(err) });
    }
  };
  /** Registers generation `from + n` for `inMs` from now; returns its `at`. */
  const register = async (n: number, inMs: number) => {
    const at = new Date(Date.now() + inMs);
    await w.register({ at: at.toISOString(), generation: from + n });
    return at;
  };
  const since = (begun: Date, n: number) =>
    host.wakes().filter((wake) => wake.generation === from + n && wake.at >= begun);
  const arrived = async (begun: Date, n: number) => {
    const [wake] = await waitFor(
      () => since(begun, n),
      (wakes) => wakes.length > 0,
      timeoutMs,
    );
    return wake!;
  };

  await check("a registered wake arrives after `at`", async (begun) => {
    const at = await register(1, 2_000);
    const wake = await arrived(begun, 1);
    if (wake.at < at) throw new Error(`the wake arrived at ${wake.at.toISOString()}, before ${at.toISOString()}`);
  });
  await check("a wake registered before a stop drains a queued run after it", async (begun) => {
    await register(2, 3_000);
    await host.stop();
    const runId = await client.start("host-check-drain", {}, { startedBy });
    await arrived(begun, 2);
    const run = await waitFor(
      () => client.run(runId),
      (r) => r !== undefined && isEnded(r.status),
      timeoutMs,
    );
    if (run?.status !== "finished") throw new Error(`run ${runId} ended ${run?.status}: ${run?.error}`);
    // TODO(L1, #311): and fires a due schedule, once the worker runs workflows on a schedule.
  });
  await check("a replaced generation runs nothing", async (begun) => {
    await register(3, 2_000);
    await register(4, 6_000);
    // A late retry of the older registration: the newer one still stands.
    await register(3, 2_000);
    await arrived(begun, 4);
    const replaced = since(begun, 3);
    if (replaced.length) {
      throw new Error(
        `generation ${from + 3}, replaced by ${from + 4}, woke the host at ${replaced[0]!.at.toISOString()}`,
      );
    }
  });
  return results;
}

const timerSchema = z.object({
  name: z.string().min(1),
  /** The host's URL: a data file names the host's declaration, which apply resolves by its `url`. */
  host: z.string().min(1),
});

/**
 * The fake wakeup's type, `testwakeup.timer`: a timer in this process that wakes the host named
 * by `host` (a `testhost.app` declaration, resolved by its `url`), which `fakeWakeup` drives.
 */
export const fakeWakeupType = defineResource({
  vendor: "testwakeup",
  type: "timer",
  title: "Test wakeup",
  identity: "name",
  schema: timerSchema,
  fields: {
    immutable: [],
    vendorOwned: [],
    writeOnly: [],
    references: { host: { type: "testhost.app", by: ["url"] } },
  },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
  wakeup: {
    inputs: { host: "host" },
    register: "testwakeup.timer.register",
    outputs: (state) => ({ healthy: typeof state.host === "string" }),
  },
});

const timerTypes = defineConnector(
  "testwakeup",
  { timer: fakeWakeupType },
  {
    title: "Test wakeup",
    // Only what a data file imports it from: no such package is published.
    package: "@sanoma-ai/testing-wakeup",
  },
);
const timerRegister = defineConnector("testwakeup", {
  timer: {
    register: {
      effect: "write",
      idempotent: true,
      description: "Wake the host at `at` with `generation`, replacing the wake registered before",
      input: z.object({ at: z.iso.datetime(), generation: z.number().int().nonnegative() }),
      output: z.object({}),
      target: () => "timer",
    },
  },
});
/** The fake wakeup's operations: the timer type's, and `timer.register` in its group (Supabase's pattern). */
const fakeWakeupOps = {
  ...timerTypes,
  timer: { ...timerTypes.timer, ...timerRegister.timer },
} as FakeWakeupOps;

/** The fake wakeup's connector type: the timer type with `timer.register`. */
export type FakeWakeupOps = typeof timerTypes & typeof timerRegister;

/** How long the fake waits before it sends a wake again that the host did not answer. */
const RETRY_MS = 250;
/** setTimeout's longest delay: a longer one fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * A wakeup in this process: `testwakeup.timer` with a driver whose `register` arms one timer for
 * the one timer it created (apply's `create`), replacing any armed before unless it is of an
 * older generation (which changes nothing), which sends
 * `GET {host}/wake?generation=N` at `at`, again every 250 ms until the host answers 2xx. `fire()`
 * sends the armed wake now; `close()` disarms it. `connector` is for a config; `driver` for
 * calling its operations directly.
 */
export function fakeWakeup() {
  const timers = new Map<string, { state: z.output<typeof timerSchema> }>();
  let armed: { registration: WakeupRegistration; url: string; timeout?: NodeJS.Timeout } | undefined;
  /** The newest generation registered: an older one, a late retry, changes nothing. */
  let newest = -1;
  const disarm = () => {
    clearTimeout(armed?.timeout);
    armed = undefined;
  };
  /** Sends `pending` again in `ms` (at most setTimeout's longest delay), one timer at a time. */
  const later = (pending: NonNullable<typeof armed>, ms: number) => {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => void send(pending), Math.min(ms, MAX_DELAY_MS)).unref();
  };
  /** Sends the wake `pending` names, while it is still the one armed, until the host answers. */
  const send = async (pending: NonNullable<typeof armed>) => {
    if (armed !== pending) return;
    const due = Date.parse(pending.registration.at) - Date.now();
    if (due > 0) return later(pending, due);
    const answered = await fetch(new URL(`/wake?generation=${pending.registration.generation}`, pending.url)).then(
      (res) => res.ok,
      () => false,
    );
    if (answered) {
      if (armed === pending) armed = undefined;
    } else if (armed === pending) later(pending, RETRY_MS);
  };
  const read = async ({ id }: { id: string }) => {
    const timer = timers.get(id);
    return timer ? { id, gone: false, state: timer.state } : { id, gone: true };
  };
  const put = async ({ desired }: { desired: Record<string, unknown> }) => {
    const state = timerSchema.parse(desired);
    timers.set(state.name, { state });
    return { id: state.name, state };
  };
  const types = defineDriver(timerTypes, {
    timer: {
      import: read,
      read,
      plan: async ({
        id,
        desired,
      }): Promise<{ action: PlanAction; planned?: Record<string, unknown>; unknown: string[]; replace: string[] }> => {
        const state = id === undefined ? undefined : timers.get(id)?.state;
        if (!desired) return { action: state ? "delete" : "none", unknown: [], replace: [] };
        if (!state) return { action: "create", planned: desired, unknown: [], replace: [] };
        const action = desired.host === state.host ? "none" : "update";
        return { action, planned: { ...state, ...desired }, unknown: [], replace: [] };
      },
      create: put,
      update: put,
      delete: async ({ id }) => {
        timers.delete(id);
        if (!timers.size) disarm();
        return { id, gone: true as const };
      },
    },
  });
  const registers = defineDriver(timerRegister, {
    timer: {
      register: async (registration) => {
        const [only, ...more] = [...timers.values()];
        if (!only || more.length) {
          throw new DriverError(`testwakeup: register wakes the one timer apply created, not ${timers.size}`, {
            retryable: false,
          });
        }
        if (registration.generation < newest) return {};
        newest = registration.generation;
        disarm();
        const pending = (armed = { registration, url: only.state.host });
        void send(pending);
        return {};
      },
    },
  });
  const driver: Driver = Object.freeze({ ...types, ops: Object.freeze({ ...types.ops, ...registers.ops }) });
  return {
    connector: withSetup(fakeWakeupOps, { driver: () => driver }),
    driver,
    /** Sends the armed wake now, whatever its `at`; resolves once the host answers it. */
    async fire() {
      const pending = armed;
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.registration = { ...pending.registration, at: new Date(0).toISOString() };
      await send(pending);
      await waitFor(() => armed !== pending, Boolean, 60_000);
    },
    /** Disarms the armed wake, if any. */
    close: disarm,
  };
}
