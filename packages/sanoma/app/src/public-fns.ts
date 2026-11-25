/**
 * The server functions a public site's host answers: a site's `api`, and who is asking. The app
 * refuses every other there (`publicOnly`), on Node and on the Worker alike. Each is its name and
 * the end of its file's path: the app's `src/functions.ts`. No imports.
 */
export const PUBLIC_FNS: ReadonlyMap<string, string> = new Map([
  ["callFn", "sanoma/app/src/functions.ts"],
  ["getActor", "sanoma/app/src/functions.ts"],
]);
