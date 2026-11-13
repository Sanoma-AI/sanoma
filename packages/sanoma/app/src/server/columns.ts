// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { PatchOutput, Principal } from "sanoma/workflows";
import type { TableChangePlan } from "sanoma/workflows/description";
import { LIST_LIMIT, PATCH_WORKFLOW, type Saved } from "sanoma/workflows/shared";
import { createApi, type UntypedApi } from "../api-client.ts";
import { ApiError, type ColumnPlanRequest, type ProposeColumnChange } from "../api.ts";
import { declarationEdit, leftOver, planOf, problemOf, targetOf } from "../components/grid/plan.ts";
import type { AppContext } from "../context.ts";
import { callApi } from "./core.ts";

// A change to a collection's columns, proposed from the grid: its plan over every record, which
// the column panel shows and asks on (`planColumnChange`), then the collection's declaration in
// `resources/data.ts` edited by the built-in `patch`, as a form's Save is, which opens a change
// for review when the repository has a remote and carries the change's plan to it.

/** A column change refused, saying why. */
const refuse = (error: string) => new ApiError(400, { error, code: "invalid_input" });

/** Every record of the collection `name`, keyed by `key`, through `api`: by key, `LIST_LIMIT.max` a page. */
async function everyRecord(api: UntypedApi, name: string, key: string): Promise<Saved[]> {
  const rows: Saved[] = [];
  for (;;) {
    const after = rows.at(-1)?.key;
    const where = after === undefined ? undefined : { [key]: { gt: after } };
    const page = (await api.data[name].list({ limit: LIST_LIMIT.max, ...(where && { where }) })) as Saved[];
    rows.push(...page);
    if (page.length < LIST_LIMIT.max) return rows;
  }
}

/**
 * The plan of `change` to the collection `name`, as `actor`, through `createApi` over `callApi`
 * as the page's own `api` is (`api`, for what follows): every one of its records read, and for a
 * change to a link every key of the collection it links to, and the plan drafted over them
 * (`planOf`). Refused (`invalid_input`) for a collection no data file declares, a change the
 * declaration cannot take (`problemOf`), and a name its records still hold values under (`leftOver`).
 */
async function planned(app: AppContext, actor: Principal, { collection: name, change }: ColumnPlanRequest) {
  const { collections } = app.snapshot.description;
  const collection = collections.find((c) => c.name === name);
  if (!collection) throw new ApiError(404, { error: `No collection ${name}` });
  const { declared } = collection;
  if (!declared) throw refuse(`${name} is not declared in a data file, so its columns change in code`);
  const problem = problemOf(
    collection,
    change,
    collections.map((c) => c.name),
  );
  if (problem) throw refuse(problem);
  const api: UntypedApi = createApi((request) => callApi(app, actor, request));
  const rows = await everyRecord(api, name, collection.key);
  const left = leftOver(rows, change);
  if (left) throw refuse(left);
  // A change to a link: the values matched against the keys of the collection it links to.
  const type = change.kind === "retype" ? change.to : change.kind === "convert" ? change.type : undefined;
  const target = type && collections.find((c) => c.name === targetOf(name, type));
  const keys =
    target && typeof type === "object" && "link" in type
      ? new Map([[type.link, new Set((await everyRecord(api, target.name, target.key)).map((row) => row.key))]])
      : undefined;
  return { api, collection, at: declared.at, plan: planOf(collection, rows, change, keys) };
}

/**
 * The plan of a proposed column change over every record of its collection, as the column panel
 * shows it and asks what becomes of the values that won't convert: the one `proposeColumnChange`
 * sends, the records as they are then.
 */
export async function planColumnChange(
  app: AppContext,
  actor: Principal,
  request: ColumnPlanRequest,
): Promise<TableChangePlan> {
  return (await planned(app, actor, request)).plan;
}

/**
 * Proposes `change` to the columns of its collection, as `actor`: its plan over every record
 * (`planned`), and `patch` called, which starts its run and asks for its result until the run has
 * ended: the change it opened (with the plan), or the file it wrote. A change that deletes values
 * (a `clear` decision, or removing a column for good) is refused with nothing written when the
 * values it deletes are no longer the `clears` the person was shown: the answer is then the plan
 * over the records as they are now (`recounted`), to choose or confirm again on.
 */
export async function proposeColumnChange(
  app: AppContext,
  actor: Principal,
  { clears, ...request }: ProposeColumnChange,
): Promise<PatchOutput | { recounted: TableChangePlan }> {
  const { api, collection, at, plan } = await planned(app, actor, request);
  const { change } = request;
  const [one] = plan.changes;
  const deletes =
    one?.kind === "remove"
      ? one.filled
      : "decision" in change && change.decision === "clear" && one && "wontConvert" in one
        ? one.wontConvert.count
        : undefined;
  if (deletes !== undefined && clears !== deletes) return { recounted: plan };
  const input = { at, ...declarationEdit(collection.fields, change), plan };
  return (await api[PATCH_WORKFLOW](input)) as PatchOutput;
}
