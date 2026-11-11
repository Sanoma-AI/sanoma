// A demo's `api` (`demo-build.ts` swaps `site-api.ts` for this module): every call answered by the
// page's runtime (`sanoma/workflows/page`), which `mount` hands it, failing as a server function
// fails, with an `ApiError`, so a form shows the message and `createApi` asks again on `run_running`.
import type { PageRuntime } from "sanoma/workflows/page";
import { errorMessage } from "sanoma/workflows/shared";
import { type Api, createApi } from "../api-client.ts";
import { ApiError, asApiError, runFailure } from "../api.ts";

/** The runtime of the demo mounted last: a page shows one demo at a time. */
let served: PageRuntime | undefined;

/** From now on `api` is `runtime`'s, until the returned function (an unmount) lets it go. */
export function serve(runtime: PageRuntime): () => void {
  served = runtime;
  return () => {
    if (served === runtime) served = undefined;
  };
}

/**
 * The company's operations and workflows, called in the page. A run's failure is its `.result`'s
 * answer as the app gives it (`runFailure`: a 422 with the run's error); anything else `asApiError`.
 */
export const api: Api = createApi(async (request) => {
  const runtime = served;
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
