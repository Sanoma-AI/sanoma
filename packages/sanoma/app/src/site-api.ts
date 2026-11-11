import { type Api, createApi } from "./api-client.ts";
import { callFn } from "./functions.ts";

/**
 * The company's operations and workflows, called as the person on the page (`callFn`): a loader's
 * call runs in-process while the server renders the page, as the person whose request it is.
 * A site's, from `sanoma/site`; the app's own calls through it are untyped. Its own module, the
 * one binding a demo's build (`demo-build.ts`) replaces with the page's runtime (`demo/api.ts`).
 */
export const api: Api = createApi((request) => callFn({ data: request }));
