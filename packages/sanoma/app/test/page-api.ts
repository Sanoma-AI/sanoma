// The app's `api` as a page has it, over the server core: what the tests of the app's built-in
// workflows (Adopt, Save, going live, connecting) call them through.
import type { Principal } from "sanoma/workflows";
import { createApi, type UntypedApi } from "../src/api-client.ts";
import type { AppContext } from "../src/context.ts";
import { asApiError } from "../src/api.ts";
import { callApi } from "../src/server/core.ts";

/**
 * `api` as the page of `actor` calls it (`queries.ts`): each call through `callApi`, failing with
 * the `ApiError` a server function fails with, so a workflow called as a function starts its run
 * and asks for its `.result` until the run has ended, as the page does.
 */
export const pageApi = (app: AppContext, actor: Principal): UntypedApi =>
  createApi((request) =>
    callApi(app, actor, request).catch((err: unknown) => {
      throw asApiError(err);
    }),
  );
