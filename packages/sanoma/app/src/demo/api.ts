// A demo's `api` (`demo-build.ts` swaps `site-api.ts` for this module): every call answered by the
// page's runtime (`sanoma/workflows/page`), which `mount` hands it, failing as a server function
// fails, with an `ApiError`, so a form shows the message and `createApi` asks again on `run_running`.
import type { PageRuntime } from "sanoma/workflows/page";
import { errorMessage } from "sanoma/workflows/shared";
import { type Api, createApi } from "../api-client.ts";
import { ApiError, asApiError, runFailure } from "../api.ts";

/** The demos still mounted, one per `mount` call, in the order they were called; `runtime` once seeded. */
const served: { runtime?: PageRuntime }[] = [];

/**
 * From now on `api` is `seeding`'s runtime once it seeds (no page of its demo calls before), until
 * the returned function (an unmount) lets it go: the runtime of the demo whose `mount` was called
 * last of those seeded and still mounted answers it.
 */
export function serve(seeding: Promise<PageRuntime>): () => void {
  const entry: { runtime?: PageRuntime } = {};
  served.push(entry);
  seeding.then((runtime) => (entry.runtime = runtime)).catch(() => {});
  return () => {
    const at = served.indexOf(entry);
    if (at !== -1) served.splice(at, 1);
  };
}

/**
 * The company's operations and workflows, called in the page. A run's failure is its `.result`'s
 * answer as the app gives it (`runFailure`: a 422 with the run's error); anything else `asApiError`.
 */
export const api: Api = createApi(async (request) => {
  const runtime = served.findLast((entry) => entry.runtime)?.runtime;
  if (!runtime) throw new ApiError(503, { error: "No demo is mounted on this page" });
  try {
    return await runtime.transport(request);
  } catch (err) {
    const runId = (request.input as { runId?: unknown } | undefined)?.runId;
    throw request.name.endsWith(".result") && typeof runId === "string"
      ? runFailure({ runId, status: "failed", error: errorMessage(err) }, err)
      : asApiError(err);
  }
});
