/**
 * The server functions a public site's host answers: a site's `api`, and who is asking. The app
 * refuses every other there (`publicOnly`), on Node and on the Worker alike. No imports.
 */
export const PUBLIC_FNS: ReadonlySet<string> = new Set(["callFn", "getActor"]);
