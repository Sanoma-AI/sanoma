// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { PatchOutput, Principal } from "@sanoma-ai/workflows";
import { LIST_LIMIT, PATCH_WORKFLOW, type Saved } from "@sanoma-ai/workflows/shared";
import { createApi, type UntypedApi } from "../api-client.ts";
import { ApiError, type ProposeColumnChange } from "../api.ts";
import { declarationEdit, planOf, problemOf } from "../components/grid/plan.ts";
import type { AppContext } from "../context.ts";
import { callApi } from "./core.ts";

// A change to a collection's columns, proposed from the grid: the collection's declaration in
// `resources/data.ts` edited by the built-in `patch`, as a form's Save is, which opens a change
// for review when the repository has a remote and carries the change's plan to it.

/** A column change refused, saying why. */
const refuse = (error: string) => new ApiError(400, { error, code: "invalid_input" });

/**
 * Proposes `change` to the columns of the collection `collection`, as `actor`, through `createApi`
 * over `callApi` as the page's own `api` is: every one of its records read (by key,
 * `LIST_LIMIT.max` a page), its plan drafted over them (`planOf`), and `patch` called, which
 * starts its run and asks for its result until the run has ended: the change it opened (with the
 * plan), or the file it wrote. Refused (`invalid_input`) for a collection no data file declares
 * and a change the declaration cannot take (`problemOf`).
 */
export async function proposeColumnChange(
  app: AppContext,
  actor: Principal,
  { collection: name, change }: ProposeColumnChange,
): Promise<PatchOutput> {
  const collection = app.snapshot.description.collections.find((c) => c.name === name);
  if (!collection) throw new ApiError(404, { error: `No collection ${name}` });
  const { declared } = collection;
  if (!declared) throw refuse(`${name} is not declared in a data file, so its columns change in code`);
  const problem = problemOf(collection, change);
  if (problem) throw refuse(problem);
  const api: UntypedApi = createApi((request) => callApi(app, actor, request));
  const rows: Saved[] = [];
  for (;;) {
    const after = rows.at(-1)?.key;
    const where = after === undefined ? undefined : { [collection.key]: { gt: after } };
    const page = (await api.data[name].list({ limit: LIST_LIMIT.max, ...(where && { where }) })) as Saved[];
    rows.push(...page);
    if (page.length < LIST_LIMIT.max) break;
  }
  const input = {
    at: declared.at,
    ...declarationEdit(collection.fields, change),
    plan: planOf(collection, rows, change),
  };
  return (await api[PATCH_WORKFLOW](input)) as PatchOutput;
}
