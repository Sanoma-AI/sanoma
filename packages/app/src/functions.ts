import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type ActorInfo, DecideCall, RunsQuery, StartRunRequest } from "./api.ts";
import { decide, parse, runDetail, startRun, withoutSources, workflowSource } from "./server/core.ts";
import { withPrincipal } from "./middleware.ts";

// The page's reads and changes, as server functions. They do what the /api routes do, with the
// same schemas; the routes stay the stable surface for scripts. Failures, the actor header and
// the actor itself are handled once for all of them, in start.ts.
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

/** A workflow's source, apart from the config since it is a whole file: asked for by name, `null` when it has none. */
export const getSource = createServerFn(READ)
  .validator(validate(z.object({ name: z.string().min(1) })))
  .handler(({ data, context }) => workflowSource(context.app, data.name));

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

export const getRuns = createServerFn(READ)
  .validator(validate(RunsQuery))
  .handler(({ data, context }) => context.app.client.runs(data));

/** The run, or the router's not-found when there is none. */
export const getRun = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => runDetail(context.app, data.id));

export const startRunFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(StartRunRequest))
  .handler(({ data, context }) => startRun(context.app, context.principal, data));

export const decideFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(DecideCall))
  .handler(({ data, context }) => decide(context.app, context.principal, data));
