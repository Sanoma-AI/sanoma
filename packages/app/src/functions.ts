import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type ActorInfo, ClearCredentialRequest, DecideCall, RunsQuery, SetCredentialRequest } from "./api.ts";
import {
  clearCredential,
  credentials,
  decide,
  driftReport,
  fileSource,
  listRuns,
  readStartRun,
  runDetail,
  scenarios,
  setCredential,
  startRun,
  validate,
  withoutSources,
} from "./server/core.ts";
import { withPrincipal } from "./middleware.ts";

// The page's reads and changes, as server functions: the app's only HTTP surface. Each parses its
// argument and calls the server core (server/core.ts). Failures, the actor header and the actor
// itself are handled once for all of them, in start.ts. Scripts reach the same runs through
// `SanomaClient` from @sanoma/workflows, not through these.
//
// Runs carry `unknown` inputs and outputs, which Start's type check can't prove serializable.
// They are JSON (they come out of Postgres and the ledger as JSON), so that check is off for
// the outputs: `strict: { output: false }`.
const READ = { method: "GET", strict: { output: false } } as const;
const CHANGE = { method: "POST", strict: { output: false } } as const;

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
  .handler(({ data, context }) => listRuns(context.app, data));

/** The run, or the router's not-found when there is none. */
export const getRun = createServerFn(READ)
  .validator(validate(z.object({ id: z.string().min(1) })))
  .handler(({ data, context }) => runDetail(context.app, data.id));

export const startRunFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(readStartRun)
  .handler(({ data, context }) => startRun(context.app, context.principal, data));

export const decideFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(DecideCall))
  .handler(({ data, context }) => decide(context.app, context.principal, data));

/** A drift run's report, once it has ended. */
export const getDriftReport = createServerFn(READ)
  .validator(validate(z.object({ runId: z.string().min(1) })))
  .handler(({ data, context }) => driftReport(context.app, data.runId));

/** Each vendor's credential statuses now: they change as people set them, and with the environment. */
export const getCredentials = createServerFn(READ).handler(({ context }) => credentials(context.app));

export const setCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(SetCredentialRequest))
  .handler(({ data, context }) => setCredential(context.app, context.principal, data));

export const clearCredentialFn = createServerFn(CHANGE)
  .middleware([withPrincipal])
  .validator(validate(ClearCredentialRequest))
  .handler(({ data, context }) => clearCredential(context.app, context.principal, data));
