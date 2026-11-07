import { type CallRequest, errorBodyOf } from "./api.ts";

// A site's `api`, from `sanoma/site` (bound to `callFn`, the app's one server function for it, in
// queries.ts): one generic client. A path names what to call (`api.data.outbound.list`,
// `api.outboundNext.start`) and the server decides what it is; the types come from the company's
// generated `.sanoma/api.ts`, which augments `Register`, so a stale file can fail a check but never
// change a call. Browser code, importing no server function, so a Node test can import it.

/**
 * What `.sanoma/api.ts` declares the company's typed `api` in:
 * `declare module "sanoma/site" { interface Register { api: Api } }`.
 */
export interface Register {}

/**
 * `api` before `.sanoma/api.ts` types it: any path, called with anything. `any`, since under the
 * sites' `noUncheckedIndexedAccess` a path read through an index signature may be undefined.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- untyped until .sanoma/api.ts
export type UntypedApi = any;

/** The company's `api`, as `.sanoma/api.ts` declares it in `Register`; `UntypedApi` without one. */
export type Api = Register extends { api: infer A } ? A : UntypedApi;

/** How `createApi` sends a call: `callFn` in the app, a fake in a test. */
export type Transport = (request: CallRequest) => Promise<unknown>;

/** A workflow's reads of its runs (`api.<workflow>.<read>`), and their arguments as the input `callApi` takes. */
const RUN_READS = new Map<string, (args: unknown[]) => unknown>([
  ["result", ([runId, waitMs]) => (waitMs === undefined ? { runId } : { runId, waitMs })],
  ["latest", () => undefined],
  ["runs", ([query]) => query],
  ["approvals", ([runId]) => ({ runId })],
  ["ledger", ([runId]) => ({ runId })],
]);

/** A new random id: a UUID, or 32 hex digits where `randomUUID` is missing (a page served over plain HTTP elsewhere than this machine). */
const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * An `api` over `transport`: a call on a path sends `{ name: <the path, joined with ".">, input }`.
 * An operation's call, a start, and a workflow called as a function send a new id each time
 * (`newId`): a retried request is made once, and a person's next attempt is a new
 * call, since a failed write's id is spent. A workflow called as a function starts it, then asks
 * for its result until the run has ended (`run_running` in between).
 */
export function createApi(transport: Transport): Api {
  async function send(path: readonly string[], args: unknown[]): Promise<unknown> {
    const name = path.join(".");
    const read = path.length === 2 ? RUN_READS.get(path[1]!) : undefined;
    if (read) return transport({ name, input: read(args) });
    const started = transport({ name, input: args[0], id: newId() });
    if (path.length !== 1) return started;
    const { runId } = (await started) as { runId: string };
    for (;;) {
      try {
        return await transport({ name: `${name}.result`, input: { runId } });
      } catch (err) {
        if (errorBodyOf(err)?.code !== "run_running") throw err;
      }
    }
  }
  const at = (path: readonly string[]): unknown =>
    new Proxy(() => {}, {
      // Never a thenable, so a path can be awaited or returned from an async function as itself.
      get: (_, key) => (typeof key === "string" && key !== "then" ? at([...path, key]) : undefined),
      apply: (_, __, args: unknown[]) => send(path, args),
    });
  return at([]) as Api;
}
