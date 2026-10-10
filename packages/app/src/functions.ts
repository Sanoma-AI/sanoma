import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type ActorInfo, DecideCall, RunsQuery, type StartRunRequest, startRunSchema } from "./api.ts";
import {
  decide,
  driftReport,
  fileSource,
  parse,
  runDetail,
  scenarios,
  startRun,
  withoutSources,
} from "./server/core.ts";
import { withPrincipal } from "./middleware.ts";

// The page's reads and changes, as server functions. Most do what an /api route does, with the
// same schemas; the routes stay the stable surface for scripts. getSource and getDriftReport have
// no route: only the page shows a file's text, and a script reads a drift run's report from its
// run. Failures, the actor header and the actor itself are handled
// once for all of them, in start.ts.
//
// Runs carry `unknown` inputs and outputs, which Start's type check can't prove serializable.
// They are JSON (they come out of Postgres and the ledger as JSON), so that check is off for
// the outputs: `strict: { output: false }`.
const READ = { method: "GET", strict: { output: false } } as const;
const CHANGE = { method: "POST", strict: { output: false } } as const;

/** A validator that refuses an argument the way the API routes do: a 400 with zod's issues. */
const validate =
  <T extends z.ZodType>(schema: T) =>
  (data: z.input<T>): z.output<T> =>
    parse(schema, data, "The request");

export const getConfig = createServerFn(READ).handler(({ context }) => withoutSources(context.app.description));

/** A file the config names (a workflow's or a data file), as it is now; `null` for any other. */
export const getSource = createServerFn(READ)
  .validator(validate(z.object({ file: z.string().min(1) })))
  .handler(({ data, context }) => fileSource(context.app, data.file));

/**
 * Who the server resolves this request to, and whether the deployment says so itself. A
 * resolver that fails is logged, and the nav says so without its detail.
 */
export const getActor = createServerFn(READ).handler(async ({ context }): Promise<ActorInfo> => {
  const fromServer = context.app.resolveActor !== undefined;
  try {
    return { fromServer, actor: (await context.actor()) ?? null };
  } catch (err) {
    console.error("sanoma app: resolveActor failed:", err);
    return { fromServer, actor: null, error: "Could not tell who you are" };
  }
});

/** The config's scenarios, read again from their feature files whenever one has changed: the agent may be editing them. */
export const getScenarios = createServerFn(READ).handler(({ context }) => scenarios(context.app));

export const getRuns = createServerFn(READ)
  .validator(validate(RunsQuery))
  .handler(({ data, context }) => context.app.client.runs(data));

/** The run, or the router's not-found when there is none. */
export const getRun = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => runDetail(context.app, data.id));

export const startRunFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator((data: StartRunRequest) => parse(startRunSchema(data), data, "The request"))
  .handler(({ data, context }) => startRun(context.app, context.principal, data));

export const decideFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(DecideCall))
  .handler(({ data, context }) => decide(context.app, context.principal, data));

/** A drift run's report, once it has ended. */
export const getDriftReport = createServerFn(READ)
  .validator(validate(z.object({ runId: z.string().min(1) })))
  .handler(({ data, context }) => driftReport(context.app, data.runId));
