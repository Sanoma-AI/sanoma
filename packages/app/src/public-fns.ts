/**
 * The server functions a public site's host answers: a site's `api`, and who is asking. The
 * container refuses every other there (`publicOnly`), and the Worker's build keeps only these
 * handlers (`buildWorker`). No imports, so the Node-only build reads it too.
 */
export const PUBLIC_FNS: ReadonlySet<string> = new Set(["callFn", "getActor"]);
