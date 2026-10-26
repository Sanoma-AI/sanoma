import type { ResolvedConfig } from "./config.ts";
import type { Principal } from "./define.ts";
import type { ConfigDescription } from "./describe.ts";
import type { PreviewAnswer, PreviewRequest } from "./policy.ts";
import {
  AGENTS,
  ANONYMOUS,
  ANONYMOUS_PRINCIPAL,
  groupNamesOf,
  previewRequests,
  VISITORS,
  visitorPrincipal,
} from "./shared.ts";

// The Permissions grid: what the policy would answer each group, for every workflow's start, the
// operations it may call, and each direct operation. A pure function of a resolved config's policy
// and its description, so the app's Permissions page and `sanoma check` (a draft's grid, on its
// `checked` event) compute it the one way, and a change is reviewed as one grid against another.

/** A row of the grid: a workflow (its start) or an operation, and the policy's answer for each column. */
export interface PermissionsRow {
  id: string;
  title?: string;
  cells: PreviewAnswer[];
}

/**
 * The grid: its columns (`null` for someone in no group, then the declared groups, `agents` and
 * `visitors`, sorted, then `anonymous`), a row for each workflow's start, with a row for each
 * operation it uses (`ops`, in its order), and a row for each operation a person may call
 * directly, each with a cell per column.
 */
export interface PermissionsGrid {
  groups: (string | null)[];
  workflows: (PermissionsRow & { ops: PermissionsRow[] })[];
  ops: PermissionsRow[];
}

/**
 * Whom the `agents` column's agent acts for: a hold `@hold("on-behalf-of")` asks them. Only an
 * agent acts for someone, so in any other column that hold refuses, as it does a person.
 */
const ACTS_FOR = "whom it acts for";

/** Whom a column of the grid asks about: someone in the group alone, a visitor, or `anonymous`. */
export function columnPrincipal(group: string | null): Principal {
  if (group === null) return { id: "group:", groups: [] };
  if (group === ANONYMOUS) return ANONYMOUS_PRINCIPAL;
  if (group === VISITORS) return visitorPrincipal("grid", "visitor");
  return { id: `group:${group}`, groups: [group], ...(group === AGENTS && { onBehalfOf: ACTS_FOR }) };
}

/**
 * The grid of `resolved`'s policy over `description`: for someone in no group, then for each
 * group, the declared ones, `agents` and `visitors` (the visitors' only beside a public site),
 * then for `anonymous`, what the policy would answer someone in it alone (`columnPrincipal`), the
 * input unknown (`Policy.preview`), for the start of each of the config's own workflows, by name,
 * each with the operations it uses, in the order it declares them (`previewRequests`), then each
 * operation a person may call directly, by id.
 */
export function permissionsGrid(
  { policy }: Pick<ResolvedConfig, "policy">,
  description: ConfigDescription,
): PermissionsGrid {
  // A visitor's columns only beside a public site, where there are visitors.
  const visitors = description.sites.some((site) => site.public);
  const groups = [
    null,
    ...groupNamesOf(description.resources).filter((g) => visitors || g !== VISITORS),
    ...(visitors ? [ANONYMOUS] : []),
  ];
  const opsById = new Map(description.ops.map((op) => [op.id, op]));
  const workflows = description.workflows.filter((w) => !w.builtin);
  const direct = description.ops.filter((op) => op.direct).toSorted((a, b) => a.id.localeCompare(b.id));
  // Every row's question, in the grid's order: each workflow's start, then the operations it may
  // call, as the run form asks them; then each direct operation.
  const asked = workflows.map((w) => previewRequests(w, opsById));
  const requests: Omit<PreviewRequest, "principal">[] = [
    ...asked.flat(),
    ...direct.map(({ id, effect }) => ({ action: { id, effect } })),
  ];
  const columns = groups.map((group) => {
    const principal = columnPrincipal(group);
    return policy.preview(requests.map((request) => ({ ...request, principal })));
  });
  const rows = requests.map(({ action: { id } }, i): PermissionsRow => ({
    id,
    cells: columns.map((answers) => answers[i]!),
  }));
  // Each workflow's rows, as many as it asked: its start, then one per operation it may call.
  let at = 0;
  return {
    groups,
    workflows: workflows.map(({ name, title }, i) => {
      const [start, ...called] = rows.slice(at, (at += asked[i]!.length));
      return { ...start!, id: name, ...(title !== undefined && { title }), ops: called };
    }),
    ops: rows.slice(at),
  };
}
