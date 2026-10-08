import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { DecideCall, RunsQuery, StartRunRequest } from "./api.ts";
import { decide, requireActor, runDetail, startRun } from "./server/core.ts";

// The page's reads and changes, as server functions. They do what the /api routes do, with the
// same schemas; the routes stay the stable surface for scripts. Failures, the actor header and
// the actor itself are handled once for all of them, in start.ts.
//
// Runs carry `unknown` inputs and outputs, which Start's type check can't prove serializable.
// They are JSON (they come out of Postgres and the ledger as JSON), so that check is off for
// the outputs: `strict: { output: false }`.
const READ = { method: "GET", strict: { output: false } } as const;
const CHANGE = { method: "POST", strict: { output: false } } as const;

export const getConfig = createServerFn(READ).handler(({ context }) => context.app.description);

export const getRuns = createServerFn(READ)
  .validator(RunsQuery)
  .handler(({ data, context }) => context.app.client.runs(data));

/** The run, or the router's not-found when there is none. */
export const getRun = createServerFn(READ)
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data, context }) => runDetail(context.app, data.id));

export const startRunFn = createServerFn(CHANGE)
  .validator(StartRunRequest)
  .handler(({ data, context }) => startRun(context.app, requireActor(context), data));

export const decideFn = createServerFn(CHANGE)
  .validator(DecideCall)
  .handler(({ data, context }) => decide(context.app, requireActor(context), data));
