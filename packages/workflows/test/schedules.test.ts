import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Client } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { prepareDatabase, WAKEUP_TABLE } from "../src/db.ts";
import {
  defineWorkflow,
  memoryLedger,
  nextFire,
  nextScheduledFire,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
  type Trigger,
  type Worker,
} from "../src/index.ts";
import { timeMatcher } from "../src/schedules.ts";
import { failure, rootWith, waitFor } from "./harness.ts";
import { appRoot } from "./tree.ts";

/** A workflow `name` on `trigger`, never started: a worker outlines only a workflow its file names. */
const scheduled = (name: string, trigger: Trigger) =>
  defineWorkflow({ name, trigger, input: z.object({}), uses: [], run: async () => undefined });

// The workflows the workers run, each named in this file; the tests' on a minute they choose.
const nightly = defineWorkflow({
  name: "nightly",
  trigger: { schedule: "0 3 * * *", timezone: "Europe/Amsterdam" },
  input: z.object({}),
  uses: [],
  run: async () => undefined,
});
const weekly = defineWorkflow({
  name: "weekly",
  trigger: { schedule: "0 8 * * 1" },
  input: z.object({}),
  uses: [],
  run: async () => undefined,
});
const byHand = defineWorkflow({
  name: "by-hand",
  trigger: "manual",
  input: z.object({}),
  uses: [],
  run: async () => 1,
});
/** Answers what it was started with. */
const answering = (name: "tick" | "denied" | "held" | "missed", schedule: string) => {
  const trigger = { schedule };
  switch (name) {
    case "tick":
      return defineWorkflow({
        name: "tick",
        trigger,
        input: z.object({}),
        uses: [],
        run: async (ctx, input) => ({ input, run: ctx.runId }),
      });
    case "denied":
      return defineWorkflow({ name: "denied", trigger, input: z.object({}), uses: [], run: async () => "ran" });
    case "held":
      return defineWorkflow({ name: "held", trigger, input: z.object({}), uses: [], run: async () => "ran" });
    case "missed":
      return defineWorkflow({
        name: "missed",
        trigger,
        input: z.object({}),
        uses: [],
        run: async (ctx, input) => ({ input, run: ctx.runId }),
      });
  }
};

const at = (iso: string) => new Date(iso);

describe("nextFire", () => {
  it("finds DBOS's cron parser where it loads it from", () => {
    const Matcher = timeMatcher();
    expect(typeof Matcher.prototype.match).toBe("function");
    expect(typeof Matcher.prototype.nextWakeupTime).toBe("function");
  });

  it("is the next instant the cron matches, strictly after, read in the time zone (UTC without one)", () => {
    const from = at("2026-03-28T12:00:00Z"); // A Saturday, the day before Amsterdam's clocks go forward.
    expect(nextFire("*/15 * * * *", undefined, from)).toEqual(at("2026-03-28T12:15:00Z"));
    expect(nextFire("0 9 * * *", undefined, from)).toEqual(at("2026-03-29T09:00:00Z"));
    expect(nextFire("0 9 * * *", "Europe/Amsterdam", from)).toEqual(at("2026-03-29T07:00:00Z"));
    expect(nextFire("0 9 * * 1-5", "America/New_York", from)).toEqual(at("2026-03-30T13:00:00Z"));
    expect(nextFire("30 2 * * *", "Asia/Kolkata", from)).toEqual(at("2026-03-28T21:00:00Z"));
    // 02:30 does not happen in Amsterdam on the 29th: the next is on the 30th.
    expect(nextFire("30 2 * * *", "Europe/Amsterdam", from)).toEqual(at("2026-03-30T00:30:00Z"));
    expect(nextFire("0 0 29 2 *", undefined, from)).toEqual(at("2028-02-29T00:00:00Z"));
  });

  it("agrees with the instants DBOS's backfill fires at", () => {
    const Matcher = timeMatcher();
    for (const [cron, zone] of [
      ["0 9 * * 1", "Europe/Amsterdam"],
      ["*/7 3 * * *", "Pacific/Auckland"],
      ["15 1 1 * *", "UTC"],
    ] as const) {
      // How DBOS's scheduler steps through a schedule's instants (dist/src/scheduler/scheduler.js).
      const matcher = new Matcher(cron, zone);
      let from = at("2026-10-24T00:00:00Z");
      for (let i = 0; i < 5; i++) {
        const next = nextFire(cron, zone, from);
        expect(matcher.match(next)).toBe(true);
        expect(next).toEqual(matcher.nextWakeupTime(from));
        from = next;
      }
    }
  });

  it("refuses, as the config is resolved, a schedule DBOS cannot read or one that never fires", () => {
    const root = appRoot("sched-odd");
    const resolve = (schedule: string) => () =>
      resolveConfig({ workflows: [scheduled("odd", { schedule })], connectors: [], root });
    expect(resolve("61 * * * *")).toThrow(
      'Workflow "odd": DBOS cannot run its schedule "61 * * * *": 61 is a invalid expression for minute',
    );
    expect(resolve("0 0 30 2 *")).toThrow(/^Workflow "odd": DBOS cannot run its schedule "0 0 30 2 \*": /);
    expect(resolve("0 0 29 2 1")).not.toThrow();
  });

  it("is the earliest of the config's scheduled workflows, none without one", () => {
    const from = at("2026-10-25T10:00:00Z");
    const workflows = (...wfs: ReturnType<typeof scheduled>[]) => ({ workflows: new Map(wfs.map((w) => [w.name, w])) });
    expect(nextScheduledFire(workflows(scheduled("by-hand", "manual")), from)).toBeUndefined();
    expect(
      nextScheduledFire(
        workflows(
          scheduled("daily", { schedule: "0 12 * * *" }),
          scheduled("soon", { schedule: "30 10 * * *" }),
          scheduled("by-hand", "manual"),
        ),
        from,
      ),
    ).toEqual(at("2026-10-25T10:30:00Z"));
  });
});

/** The app's schedules as DBOS lists them, with what decides how they fire. */
const schedulesOf = async (app: string) =>
  (await DBOS.listSchedules({ scheduleNamePrefix: `${app}/` })).map((s) => ({
    name: s.scheduleName,
    workflow: s.workflowName,
    schedule: s.schedule,
    timezone: s.cronTimezone,
    queue: s.queueName,
    backfill: s.automaticBackfill,
  }));
/** A cron firing once a day, at the minute three minutes ago (UTC), and that minute. */
const pastTick = () => {
  const tick = new Date(Math.floor((Date.now() - 3 * 60_000) / 60_000) * 60_000);
  return { tick, schedule: `${tick.getUTCMinutes()} ${tick.getUTCHours()} * * *` };
};
const unique = (name: string) => `${name}-${Date.now()}`;

describe("schedules on Postgres", () => {
  // Needs Postgres: `pnpm db:up`.
  const databaseUrl = testDatabaseUrl("schedules");
  let worker: Worker | undefined;
  let client: SanomaClient | undefined;
  const ledger = memoryLedger();
  /** A config of an app of its own (a fresh name each run, so its schedules are new) with `workflows`. */
  const config = (app: string, workflows: SanomaConfig["workflows"], root = appRoot(app)): SanomaConfig => ({
    workflows,
    connectors: [],
    ledger,
    root,
    databaseUrl,
  });
  const start = async (cfg: SanomaConfig, options: { promote?: boolean } = {}) => {
    worker = await startWorker(cfg, options);
    client ??= await SanomaClient.connect(cfg);
    return worker;
  };
  const stop = async () => {
    await worker?.stop();
    worker = undefined;
  };
  /** Sets the wakeup row's `stopped_at`, as a worker stopping does. */
  const stoppedAt = async (when: Date | null) => {
    const pg = new Client({ connectionString: databaseUrl });
    await pg.connect();
    try {
      await pg.query(`UPDATE ${WAKEUP_TABLE} SET stopped_at = $1 WHERE id = 1`, [when]);
    } finally {
      await pg.end();
    }
  };
  beforeAll(() => prepareDatabase(databaseUrl));
  beforeEach(() => stoppedAt(null));
  afterEach(async () => {
    delete process.env.DBOS__APPVERSION;
    await stop();
    await client?.close();
    client = undefined;
  });

  it("applies one schedule per scheduled workflow, named <app>/<workflow>, and deletes one no longer declared", async () => {
    const app = unique("sched-apply");
    const root = appRoot(app);
    const cfg = config(app, [nightly, weekly, byHand], root);
    const { queueName } = resolveConfig(cfg);
    await start(cfg);
    expect(await schedulesOf(app)).toEqual([
      {
        name: `${app}/nightly`,
        workflow: "nightly",
        schedule: "0 3 * * *",
        timezone: "Europe/Amsterdam",
        queue: queueName,
        backfill: true,
      },
      // UTC, not the process's own zone, which DBOS reads a cron in without one.
      {
        name: `${app}/weekly`,
        workflow: "weekly",
        schedule: "0 8 * * 1",
        timezone: "UTC",
        queue: queueName,
        backfill: true,
      },
    ]);
    await stop();

    await start(config(app, [nightly], root));
    expect((await schedulesOf(app)).map((s) => s.name)).toEqual([`${app}/nightly`]);
  });

  it("applies none on a worker started without them, as runScenarios' is", async () => {
    const app = unique("sched-off");
    worker = await startWorker(config(app, [nightly]), { schedules: false });
    expect(await schedulesOf(app)).toEqual([]);
  });

  it("leaves the schedules alone on a worker that is not the latest version, until it is promoted", async () => {
    const app = unique("sched-version");
    const root = appRoot(app);
    process.env.DBOS__APPVERSION = "v1";
    await start(config(app, [nightly, weekly], root));
    await stop();
    process.env.DBOS__APPVERSION = "v2";
    await start(config(app, [nightly], root));
    expect((await schedulesOf(app)).map((s) => s.name)).toEqual([`${app}/nightly`]);
    await stop();

    // v1 again is a rollback: it neither adds its weekly back nor deletes anything.
    process.env.DBOS__APPVERSION = "v1";
    await start(config(app, [weekly], root));
    expect((await schedulesOf(app)).map((s) => s.name)).toEqual([`${app}/nightly`]);
    await stop();
    await start(config(app, [weekly], root), { promote: true });
    expect((await schedulesOf(app)).map((s) => s.name)).toEqual([`${app}/weekly`]);
  });

  it("fires a tick as a run of the workflow under its own name, by the schedule agent with {}", async () => {
    const app = unique("sched-tick");
    const { tick, schedule } = pastTick();
    await start(config(app, [answering("tick", schedule)]));
    const [handle] = await DBOS.backfillSchedule(`${app}/tick`, new Date(tick.getTime() - 1_000), new Date());
    const runId = handle!.workflowID;
    expect(runId).toBe(`sched-${app}/tick-${tick.toISOString()}`);
    expect(await client!.result(runId)).toEqual({ input: {}, run: runId });
    expect(await client!.run(runId)).toMatchObject({
      workflow: "tick",
      status: "finished",
      startedBy: { id: "schedule" },
    });
    const [started] = await client!.ledger(runId);
    expect(started).toMatchObject({
      type: "run.started",
      workflow: "tick",
      actor: { id: "schedule" },
      input: {},
      scheduledFor: tick.toISOString(),
    });
  });

  it("fails a tick the policy denies, or holds, with the reason, as the schedule agent its data files declare", async () => {
    const app = unique("sched-policy");
    const root = rootWith({
      "package.json": JSON.stringify({ name: app }),
      "resources/people.ts": [
        'import { sanoma } from "@sanoma-ai/workflows/resources";',
        'export const ada = sanoma.person({ id: "ada" });',
        "",
      ].join("\n"),
      "policies/schedule.cedar": [
        '@reason("The nightly report is paused")',
        'forbid (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:denied", resource);',
        '@hold("ada")',
        'forbid (principal == Sanoma::Principal::"schedule", action == Sanoma::Action::"workflow:held", resource);',
        "",
      ].join("\n"),
    });
    const { tick, schedule } = pastTick();
    await start(config(app, [answering("denied", schedule), answering("held", schedule)], root));
    for (const [name, reason] of [
      ["denied", "The nightly report is paused"],
      ["held", "it needs ada to approve it, and a scheduled start waits for no approval"],
    ] as const) {
      const [handle] = await DBOS.backfillSchedule(`${app}/${name}`, new Date(tick.getTime() - 1_000), new Date());
      const runId = handle!.workflowID;
      expect(await failure(client!.result(runId))).toMatchObject({
        code: "policy_denied",
        message: `workflow:${name} was denied by policy: ${reason}`,
      });
      const records = await client!.ledger(runId);
      expect(records.map((r) => r.type)).toEqual(["run.started", "run.failed"]);
      expect(records[0]).toMatchObject({ actor: { id: "schedule", groups: ["agents"] } });
      expect(records[1]).toMatchObject({ error: { code: "policy_denied" } });
    }
  });

  it("fires a tick missed while the instance was stopped once, across starts, and none from before the schedule", async () => {
    const app = unique("sched-missed");
    const root = appRoot(app);
    const { tick, schedule } = pastTick();
    const cfg = config(app, [answering("missed", schedule)], root);
    const runsOf = async () =>
      (await DBOS.listWorkflows({ workflowName: "missed", applicationName: app, loadInput: false })).map(
        (r) => r.workflowID,
      );
    // Stopped before the tick, but the schedule is new: the tick was not yet its to fire.
    await stoppedAt(new Date(tick.getTime() - 60_000));
    await start(cfg);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await runsOf()).toEqual([]);
    // As if it had been applied well before the tick.
    await DBOS.updateSchedule(`${app}/missed`, {
      context: { since: new Date(tick.getTime() - 10 * 60_000).toISOString() },
    });
    await stop();

    await start(cfg);
    const runId = `sched-${app}/missed-${tick.toISOString()}`;
    await waitFor(async () => (await runsOf()).length > 0);
    expect(await client!.result(runId)).toEqual({ input: {}, run: runId });
    // Fired up to this start: the next one backfills from here.
    const { since } = (await DBOS.getSchedule(`${app}/missed`))!.context as { since: string };
    expect(Date.parse(since)).toBeGreaterThan(tick.getTime());
    await stop();
    await start(cfg);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await runsOf()).toEqual([runId]);
  });
});
