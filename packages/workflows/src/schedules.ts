import { DBOS, type ScheduledWorkflowFn, type WorkflowSchedule } from "@dbos-inc/dbos-sdk";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import { type Db, WAKEUP_TABLE } from "./db.ts";
import type { Principal, WorkflowDefinition } from "./define.ts";
import { readPeople, admit } from "./resources.ts";
import type { WorkerState } from "./run.ts";
import { errorMessage, SCHEDULE_AGENT } from "./shared.ts";

// Server-only: the worker's side of `trigger: { schedule, timezone? }`. DBOS fires the schedules
// (its scheduler, `DBOS.applySchedules`); this names them, keeps them to the config's, fires a
// tick missed while the instance was stopped, and decides each scheduled start.

/** A workflow on a schedule: its cron expression of five fields, and the IANA time zone it is read in. */
export interface ScheduledWorkflow {
  name: string;
  schedule: string;
  /** UTC when the trigger names none: DBOS would read the cron in the process's own zone. */
  timezone: string;
}

/** The config's workflows on a schedule, in the config's order. */
export const scheduledWorkflows = ({ workflows }: Pick<ResolvedConfig, "workflows">): ScheduledWorkflow[] =>
  [...workflows.values()].flatMap(({ name, trigger }) =>
    trigger === "manual" ? [] : [{ name, schedule: trigger.schedule, timezone: trigger.timezone ?? "UTC" }],
  );

/**
 * A workflow's schedule's name in DBOS: `<appName>/<workflow>`. Names are unique across every app
 * on the system database, so the app's name comes first, and the app's own are those under it.
 */
const scheduleName = (appName: string, workflow: string): string => `${appName}/${workflow}`;

/**
 * Makes DBOS's schedules of the app the config's: one per scheduled workflow (`scheduleName`),
 * firing it by its registered function in `registry` on the app's queue, with DBOS's automatic
 * backfill (from the schedule's last fire); every other schedule under the app's name is deleted.
 * Each keeps, as its context, from when its ticks are due (`since`). Then, when the instance last
 * stopped (`sanoma_wakeup.stopped_at`), it fires once each tick missed since, of a schedule that
 * has never fired, which DBOS's backfill leaves out, never one from before `since`, and moves
 * `since` to now. A repeat is harmless anyway: a tick's run id is its time, so DBOS starts it once.
 * Only the app's latest version calls this (`startWorker`): an older one must not undo a newer's.
 */
export async function applyScheduled(
  resolved: Pick<ResolvedConfig, "appName" | "queueName" | "workflows">,
  registry: ReadonlyMap<string, ScheduledWorkflowFn>,
  db: () => Promise<Db>,
): Promise<void> {
  const { appName, queueName } = resolved;
  const before = new Map(
    (await DBOS.listSchedules({ scheduleNamePrefix: scheduleName(appName, "") })).map((s) => [s.scheduleName, s]),
  );
  const now = new Date();
  const declared = scheduledWorkflows(resolved).map(({ name, schedule, timezone }) => {
    const named = scheduleName(appName, name);
    // A schedule whose cron or zone changed is a new one: its ticks before now were never due.
    const prior = before.get(named);
    const same = prior?.schedule === schedule && (prior.cronTimezone ?? "UTC") === timezone;
    const since = (same && sinceOf(prior)) || now;
    const context: ScheduleContext = { since: since.toISOString() };
    return {
      since,
      schedule: {
        scheduleName: named,
        workflowFn: registry.get(name)!,
        schedule,
        cronTimezone: timezone,
        automaticBackfill: true,
        queueName,
        context,
      },
    };
  });
  if (declared.length) await DBOS.applySchedules(declared.map((d) => d.schedule));
  const names = new Set(declared.map((d) => d.schedule.scheduleName));
  await Promise.all([...before.keys()].filter((name) => !names.has(name)).map((name) => DBOS.deleteSchedule(name)));
  const unfired = declared.filter((d) => before.get(d.schedule.scheduleName)?.lastFiredAt === null);
  if (!unfired.length) return;
  const stoppedAt = await lastStopped(await db());
  if (!stoppedAt) return;
  for (const { schedule, since } of unfired) {
    const from = stoppedAt > since ? stoppedAt : since;
    if (from >= now) continue;
    await DBOS.backfillSchedule(schedule.scheduleName, from, now);
    // Fired up to now: the next start backfills from here, not over the same ticks again.
    const covered: ScheduleContext = { since: now.toISOString() };
    await DBOS.updateSchedule(schedule.scheduleName, { context: covered });
  }
}

/**
 * What a schedule keeps in DBOS's `context`: from when its ticks are the runtime's to fire, ISO
 * 8601: when it was applied with its cron and zone, or the end of its last backfill.
 */
interface ScheduleContext {
  since: string;
}

/** When the schedule was first applied, from its context; undefined for none, or one without it. */
function sinceOf(schedule: WorkflowSchedule | undefined): Date | undefined {
  const since = (schedule?.context as Partial<ScheduleContext> | null | undefined)?.since;
  const at = typeof since === "string" ? new Date(since) : undefined;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

/** When the instance's worker last stopped, from the wakeup's row; undefined while it never has. */
async function lastStopped(db: Db): Promise<Date | undefined> {
  const { rows } = await db.query<{ stopped_at: Date | null }>(`SELECT stopped_at FROM ${WAKEUP_TABLE} WHERE id = 1`);
  return rows[0]?.stopped_at ?? undefined;
}

/** Who starts a scheduled run, as `scheduledStarter` admitted them, or why they were not. */
export interface ScheduledStarter {
  startedBy: Principal;
  refused?: string;
}

/**
 * Who starts a scheduled run: the runtime's `schedule` agent as the data files declare it
 * (`admit`), in a step, since the files may change before a replay. A refusal is the step's
 * answer, for the run to throw once it has started, so the ledger records it; the run starts as
 * the agent alone then. A failure of the step itself (the worker stopping) is thrown as it is.
 */
export async function scheduledStarter(state: Pick<WorkerState, "root">): Promise<ScheduledStarter> {
  const admitted = await DBOS.runStep(
    async (): Promise<{ startedBy: Principal } | { refused: string }> => {
      try {
        return { startedBy: admit({ id: SCHEDULE_AGENT }, readPeople(state.root)) };
      } catch (err) {
        return { refused: errorMessage(err) };
      }
    },
    { name: "schedule:starter" },
  );
  return "refused" in admitted ? { startedBy: { id: SCHEDULE_AGENT }, refused: admitted.refused } : admitted;
}

/** DBOS's cron parser (`TimeMatcher`), as its scheduler and backfill use it. */
interface TimeMatcher {
  match(date: Date | number): boolean;
  /** The first instant strictly after `date` that matches; one that does not at the end of its search horizon. */
  nextWakeupTime(date: Date | number): Date;
}
type TimeMatcherClass = new (pattern: string, timezone?: string) => TimeMatcher;

let matcherClass: TimeMatcherClass | undefined;

/**
 * DBOS's `TimeMatcher`, from `dist/src/scheduler/crontab.js` beside its main module: the package's
 * exports leave it out (dbos-sdk 5.2.11), so it is loaded by path, and a test holds it there.
 */
export function timeMatcher(): TimeMatcherClass {
  if (matcherClass) return matcherClass;
  const require = createRequire(import.meta.url);
  const file = join(dirname(require.resolve("@dbos-inc/dbos-sdk")), "scheduler", "crontab.js");
  const loaded = (require(file) as { TimeMatcher?: unknown }).TimeMatcher;
  if (typeof loaded !== "function") throw new Error(`DBOS's cron parser is not in ${file} any more`);
  return (matcherClass = loaded as TimeMatcherClass);
}

/**
 * When `schedule` (a cron expression read in `timezone`, UTC without one) fires next, strictly
 * after `from`: as DBOS's scheduler finds it. Throws for a schedule that never fires.
 */
export function nextFire(schedule: string, timezone: string | undefined, from: Date): Date {
  const matcher = new (timeMatcher())(schedule, timezone ?? "UTC");
  // Past a horizon of a century DBOS answers an instant that does not match, as its scheduler
  // would wait for it and look again: a few looks find any schedule that ever fires.
  let at = from.getTime();
  for (let look = 0; look < 4; look++) {
    const next = matcher.nextWakeupTime(at);
    if (matcher.match(next)) return next;
    at = next.getTime();
  }
  throw new Error("it never fires");
}

/**
 * Throws when DBOS could not run the workflow's schedule: a cron its parser refuses (a minute of
 * 61), or one that never fires (30 February). `resolveConfig` runs it, so the worker, the app and
 * `sanoma check` refuse the config before any schedule is applied.
 */
export function checkSchedule({ name, trigger }: Pick<WorkflowDefinition, "name" | "trigger">): void {
  if (trigger === "manual") return;
  try {
    nextFire(trigger.schedule, trigger.timezone, new Date());
  } catch (err) {
    throw new Error(`Workflow "${name}": DBOS cannot run its schedule "${trigger.schedule}": ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * The earliest next fire, strictly after `from`, of the config's scheduled workflows; undefined
 * when none is on a schedule: the deadline a schedule sets for a worker that stops when quiet.
 */
export function nextScheduledFire(resolved: Pick<ResolvedConfig, "workflows">, from: Date): Date | undefined {
  let earliest: Date | undefined;
  for (const { schedule, timezone } of scheduledWorkflows(resolved)) {
    const next = nextFire(schedule, timezone, from);
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}
