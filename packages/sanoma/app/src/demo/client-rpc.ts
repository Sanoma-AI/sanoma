// What a server function is in a demo (`demo-build.ts` aliases `@tanstack/react-start/client-rpc`
// to this module): Start's compiler makes each one a client stub from `createClientRpc`, which here
// fails at once, so no request ever leaves the page. A site's `api` is the page runtime's
// (`demo/api.ts`); only the app's own pages call the others.
import { ApiError } from "../api.ts";

/** Start's mark on a server function (`TSS_SERVER_FUNCTION`), a registered symbol. */
const SERVER_FUNCTION = Symbol.for("TSS_SERVER_FUNCTION");

export function createClientRpc(functionId: string) {
  return Object.assign(() => Promise.reject(new ApiError(503, { error: "A demo has no server: this needs the app" })), {
    url: "",
    serverFnMeta: { id: functionId },
    [SERVER_FUNCTION]: true,
  });
}
