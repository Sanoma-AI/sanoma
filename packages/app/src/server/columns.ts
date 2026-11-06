// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { PatchOutput, Principal } from "@sanoma-ai/workflows";
import { LIST_LIMIT, PATCH_WORKFLOW, type Saved } from "@sanoma-ai/workflows/shared";
import { ApiError, type ProposeColumnChange } from "../api.ts";
import { declarationEdit, planOf, problemOf } from "../components/grid/plan.ts";
import type { AppContext } from "../context.ts";
import { callApi } from "./core.ts";

// A change to a collection's columns, proposed from the grid: the collection's declaration in
// `resources/data.ts` edited by the built-in `patch`, as a form's Save is, which opens a change
// for review when the repository has a remote and carries the change's plan to it.

/**
 * Proposes `change` to the columns of the collection `collection`, as `actor`: its records read
 * as `actor` (at most `LIST_LIMIT.max`), its plan drafted over them (`planOf`), and a `patch` run
 * started and waited for through `callApi`, as the page's own Save calls it: the change it opened
 * (with the plan), or the file it wrote. Refused (`invalid_input`) for a change the declaration
 * cannot take (`problemOf`) and a collection no data file declares.
 */
export async function proposeColumnChange(
  app: AppContext,
  actor: Principal,
  { collection: name, change }: ProposeColumnChange,
): Promise<PatchOutput> {
  const collection = app.snapshot.description.collections.find((c) => c.name === name);
  if (!collection) throw new ApiError(404, { error: `No collection ${name}` });
  const problem = collection.declared
    ? problemOf(collection, change)
    : `${name} is not declared in a data file, so its columns change in code`;
  if (problem) throw new ApiError(400, { error: problem, code: "invalid_input" });
  const rows = (await callApi(app, actor, {
    name: `data.${name}.list`,
    input: { limit: LIST_LIMIT.max },
  })) as Saved[];
  const input = {
    at: collection.declared!.at,
    ...declarationEdit(collection.fields, change),
    plan: planOf(collection, rows, change),
  };
  const { runId } = (await callApi(app, actor, { name: PATCH_WORKFLOW, input })) as { runId: string };
  return (await callApi(app, actor, { name: `${PATCH_WORKFLOW}.result`, input: { runId } })) as PatchOutput;
}
