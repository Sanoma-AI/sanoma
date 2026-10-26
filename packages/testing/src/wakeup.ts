import { setTimeout as delay } from "node:timers/promises";
import {
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  type Driver,
  type PlanAction,
  DriverError,
  errorMessage,
  nextFire,
  type Resource,
  type SanomaClient,
  type WakeupRegistration,
  withSetup,
} from "@sanoma-ai/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import { type HostCheck, hostCheckWorkflows, type Wake } from "./host.ts";

// The conformance kit for the `Wakeup` contract: whether a wakeup type wakes a stopped host when
// the runtime asked it to, and only then. `checkWakeup` registers wakes through the type's
// register operation and watches the `/wake` requests the host answers. `fakeWakeup` is a
// wakeup in this process, for the kit's own tests and for building against the contract before
// a real wakeup lands.

/** The schedule of `wakeupCheckWorkflows`' `wakeup-check-tick`: every minute, the most often a cron fires. */
const TICK = "* * * * *";

/**
 * The workflows the checks start or wait for, which the host's config registers: the host
 * checks' (`hostCheckWorkflows`), and `wakeup-check-tick`, on a schedule of every minute. Give
 * the host's root a `package.json` naming an app of its own for each run of the checks: DBOS
 * fires every tick an app's schedule missed since it last fired.
 */
export const wakeupCheckWorkflows = [
  ...hostCheckWorkflows,
  defineWorkflow({
    name: "wakeup-check-tick",
    trigger: { schedule: TICK },
    input: z.object({}),
    uses: [],
    run: async () => ({ ticked: true }),
  }),
] as const;

/** A declared wakeup under test, the host it wakes, and how to drive it. */
export interface WakeupUnderTest {
  /** Its resource type, which meets the contract (`wakeup`). */
  type: Pick<Resource, "vendor" | "type" | "wakeup">;
  /** The host the wakeup is declared for, already applied and named by the wakeup's `host`. */
  host: {
    url: string;
    /** Stops the company's runtime as the host's lifetime does, the URL kept: the next request starts it. */
    stop(): Promise<void>;
    /** Each `GET /wake` the host answered so far, across its stops, in order. */
    wakes(): readonly Wake[];
  };
  /** A client on the host's database, its config with `wakeupCheckWorkflows`. */
  client: SanomaClient;
  /** Calls the type's register operation (`wakeup.register`) through its driver. */
  register(registration: WakeupRegistration): Promise<void>;
  /** How long a check waits for a wake or a run, besides the minute it may wait for a schedule's tick. Default 60 s. */
  timeoutMs?: number;
}

/** One check's outcome. */
export type WakeupCheck = HostCheck;

const startedBy = { id: "wakeup-check" };

/** Throws when `wake` arrived before `at`. */
const notBefore = (wake: Wake, at: Date, what = "the wake") => {
  if (wake.at < at) throw new Error(`${what} arrived at ${wake.at.toISOString()}, before ${at.toISOString()}`);
};

/**
 * Runs the conformance checks against a wakeup, in order, each on its own (one failing goes on
 * to the next): a registered wake arrives at the host after its `at`; a wake registered before
 * the host stops starts it, and a run queued while it was stopped drains; a registration
 * replaced before its `at` never wakes the host, the one that replaced it does; and a wake
 * registered for a schedule's next fire, which falls while the host is stopped, runs that tick.
 * Each reads only the wakes the host answered since it began, and waits for the first.
 */
export async function checkWakeup(w: WakeupUnderTest): Promise<WakeupCheck[]> {
  const { type, host, client, timeoutMs = 60_000 } = w;
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
  /** Registers a wake `inMs` from now; returns its `at`. */
  const register = async (inMs: number) => {
    const at = new Date(Date.now() + inMs);
    await w.register({ at: at.toISOString() });
    return at;
  };
  /** The first wake the host answered since `begun`. */
  const arrived = async (begun: Date) => {
    const [wake] = await waitFor(
      () => host.wakes().filter((answered) => answered.at >= begun),
      (wakes) => wakes.length > 0,
      timeoutMs,
    );
    return wake!;
  };
  await check("a registered wake arrives after `at`", async (begun) => {
    const at = await register(2_000);
    notBefore(await arrived(begun), at);
  });
  await check("a wake registered before a stop drains a queued run after it", async (begun) => {
    await register(3_000);
    await host.stop();
    const runId = await client.start("host-check-drain", {}, { startedBy });
    await arrived(begun);
    // Throws the run's error, or that it has not ended in time.
    await client.result(runId, timeoutMs);
  });
  await check("a registration replaced before `at` never wakes the host", async (begun) => {
    const replaced = await register(2_000);
    const at = await register(5_000);
    notBefore(await arrived(begun), at, `a wake (the replaced one, at ${replaced.toISOString()}?)`);
  });
  await check("a wake at a schedule's next fire, while the host is stopped, runs that tick", async (begun) => {
    // The tick's run, as the ledger records the time it was for; any tick's without `at`.
    const tickRun = async (at?: Date) => {
      // The newest first: the tick waited for is among the last few.
      const runs = await client.runs({ workflow: "wakeup-check-tick", limit: at ? 10 : 1 });
      if (!at) return runs[0];
      const starts = await Promise.all(runs.map(async (run) => (await client.ledger(run.runId))[0]));
      return runs.find((_, i) => {
        const started = starts[i];
        return started?.type === "run.started" && started.scheduledFor === at.toISOString();
      });
    };
    // DBOS fires a tick missed while the host was stopped from the schedule's last fire, so one
    // fires first, while the host runs (once a minute).
    await waitFor(() => tickRun(), Boolean, 60_000 + timeoutMs);
    await host.stop();
    // At least two seconds on, so the host is stopped before it falls.
    const tick = nextFire(TICK, "UTC", new Date(Date.now() + 2_000));
    await register(tick.getTime() - Date.now());
    await delay(Math.max(0, tick.getTime() - Date.now()));
    await arrived(begun);
    const run = await waitFor(() => tickRun(tick), Boolean, timeoutMs);
    await client.result(run!.runId, timeoutMs);
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
      description: "Wake the host at `at`, replacing the wake registered before",
      input: z.object({ at: z.iso.datetime() }),
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
 * the one timer it created (apply's `create`), replacing any armed before (it keeps the last
 * registration), which sends `GET {host}/wake` at `at`, again every 250 ms until the host answers
 * 2xx. `fire()` sends the armed wake now; `registered()` lists the registrations it took;
 * `close()` disarms it. `connector` is for a config; `driver` for calling its operations directly.
 */
export function fakeWakeup() {
  const timers = new Map<string, z.output<typeof timerSchema>>();
  let armed: { registration: WakeupRegistration; url: string; timeout?: NodeJS.Timeout; sending?: boolean } | undefined;
  const registrations: WakeupRegistration[] = [];
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
    // One request at a time: the one in flight sends again if it is not answered.
    if (armed !== pending || pending.sending) return;
    const due = Date.parse(pending.registration.at) - Date.now();
    if (due > 0) return later(pending, due);
    pending.sending = true;
    const answered = await (async () => {
      const res = await fetch(new URL("/wake", pending.url));
      return res.ok;
    })().catch(() => false);
    pending.sending = false;
    if (armed !== pending) return;
    if (answered) armed = undefined;
    else later(pending, RETRY_MS);
  };
  const read = async ({ id }: { id: string }) => {
    const state = timers.get(id);
    return state ? { id, gone: false, state } : { id, gone: true };
  };
  const put = async ({ desired }: { desired: Record<string, unknown> }) => {
    const state = timerSchema.parse(desired);
    timers.set(state.name, state);
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
        const state = id === undefined ? undefined : timers.get(id);
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
        registrations.push(registration);
        disarm();
        const pending = (armed = { registration, url: only.host });
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
      void send(pending);
      await waitFor(() => armed !== pending, Boolean, 60_000);
    },
    /** Each registration it took, in order. */
    registered: (): readonly WakeupRegistration[] => registrations,
    /** Disarms the armed wake, if any. */
    close: disarm,
  };
}
