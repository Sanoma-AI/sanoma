import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { ACTOR_HEADER, ApiError, DecideCall, type Outcome, RunsQuery, StartRunRequest } from "./api.ts";
import { loadActor } from "./actor.ts";
import { getApp } from "./server/app.ts";
import { asApiError, decide, listRuns, requireActor, runDetail, startRun } from "./server/core.ts";

// The page's reads and changes, as server functions. They do what the /api routes do, with the
// same schemas; the routes stay the stable surface for scripts.
//
// Runs carry `unknown` inputs and outputs, which Start's type check can't prove serializable.
// They are JSON (they come out of Postgres and the ledger as JSON), so that check is off for
// the outputs: `strict: { output: false }`.
const READ = { method: "GET", strict: { output: false } } as const;
const CHANGE = { method: "POST", strict: { output: false } } as const;

/** Sends the name this browser keeps, URI-encoded so any name fits in a header. */
const actorHeader = createMiddleware({ type: "function" }).client(({ next }) => {
  const actor = loadActor();
  return next(actor ? { headers: { [ACTOR_HEADER]: encodeURIComponent(actor) } } : {});
});

/** Runs a read. Its failures are unexpected; the page shows their message. */
async function guarded<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (err) {
    const api = asApiError(err);
    if (api.status >= 500) console.error("sanoma app: a server function failed:", err);
    throw api;
  }
}

/** Runs a change, answering with its outcome: the page needs the status and body of an expected failure. */
async function outcome<T>(handler: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await handler() };
  } catch (err) {
    const api = asApiError(err);
    if (api.status >= 500) console.error("sanoma app: a server function failed:", err);
    return { ok: false, status: api.status, error: api.body };
  }
}

export const getConfig = createServerFn(READ).handler(() => guarded(async () => getApp().description));

export const getRuns = createServerFn(READ)
  .validator(RunsQuery)
  .handler(({ data }) => guarded(() => listRuns(data.limit)));

/** The run, or null when there is none. */
export const getRun = createServerFn(READ)
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) =>
    guarded(async () => {
      try {
        return await runDetail(data.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    }),
  );

export const startRunFn = createServerFn(CHANGE)
  .middleware([actorHeader])
  .validator(StartRunRequest)
  .handler(({ data }) =>
    outcome(async () => {
      const app = getApp();
      return startRun(await requireActor(app, getRequest()), data);
    }),
  );

export const decideFn = createServerFn(CHANGE)
  .middleware([actorHeader])
  .validator(DecideCall)
  .handler(({ data }) =>
    outcome(async () => {
      const app = getApp();
      return decide(await requireActor(app, getRequest()), data);
    }),
  );
