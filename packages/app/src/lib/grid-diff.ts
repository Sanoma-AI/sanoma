import type { PreviewAnswer } from "@sanoma-ai/workflows";
import type { PermissionsGrid, PermissionsRow } from "@sanoma-ai/workflows/describe";
import { ANONYMOUS, approverLabel } from "@sanoma-ai/workflows/shared";

// One Permissions grid against another (a change's branch against main): the columns and rows
// of both, aligned by group and by row, and each cell's answer before and after. Pure, so the
// change page and its review card compute it the one way.

/**
 * What a cell's answer did: `looser` and `tighter` by strictness (`deny`, then `hold`, then
 * `allow`); `changed` to or from `depends`, or the same hold asking someone else; `added` and
 * `removed`, a cell of a new or removed row or column.
 */
export type CellChange = "same" | "looser" | "tighter" | "changed" | "added" | "removed";

export interface DiffCell {
  before?: PreviewAnswer;
  after?: PreviewAnswer;
  change: CellChange;
}

/** A row of both grids: `changed` when a cell of its own or of an operation under it is. */
export interface DiffRow {
  id: string;
  title?: string;
  status: "same" | "added" | "removed" | "changed";
  cells: DiffCell[];
  /** A workflow's: the operations it uses, in its order. */
  ops?: DiffRow[];
}

/** The two grids as one: the columns of both (after's, then the removed ones), its rows, and how many cells did what. */
export interface GridDiff {
  groups: { group: string | null; status: "same" | "added" | "removed" }[];
  workflows: DiffRow[];
  ops: DiffRow[];
  /** Any column or row is not the same. */
  changed: boolean;
  counts: Record<CellChange, number>;
}

/** How much an answer lets through: `depends` is no step on this scale. */
const STRICTNESS = { deny: 0, hold: 1, allow: 2 } as const;

const sameApprover = (a: PreviewAnswer["approver"], b: PreviewAnswer["approver"]) =>
  a === undefined || b === undefined || typeof a === "string" || typeof b === "string" ? a === b : a.group === b.group;

/** What became of a cell's answer. The rule behind it is not the answer: a cell whose rule alone changed is the same. */
export function compareAnswers(before?: PreviewAnswer, after?: PreviewAnswer): CellChange {
  if (before === undefined) return after === undefined ? "same" : "added";
  if (after === undefined) return "removed";
  if (before.answer === after.answer) return sameApprover(before.approver, after.approver) ? "same" : "changed";
  if (before.answer === "depends" || after.answer === "depends") return "changed";
  return STRICTNESS[after.answer] > STRICTNESS[before.answer] ? "looser" : "tighter";
}

/** Each of `after`'s items, then each of `before`'s it lacks, by key: the union in a stable order. */
function union<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): T[] {
  const kept = new Set(after.map(key));
  return [...after, ...before.filter((item) => !kept.has(key(item)))];
}

/** Rows by `id#occurrence`: a workflow may use an operation twice; elsewhere an id is the row's alone. */
function byOccurrence<R extends PermissionsRow>(rows: readonly R[]): Map<string, R> {
  const seen = new Map<string, number>();
  return new Map(
    rows.map((row) => {
      const n = seen.get(row.id) ?? 0;
      seen.set(row.id, n + 1);
      return [`${row.id}#${n}`, row];
    }),
  );
}

/**
 * `before` against `after`: the columns of both, by group, `after`'s in its order and then the
 * removed ones; the workflows by id, each with the operations it uses by `id#occurrence`; the
 * direct operations by id. A row or column only `after` has is `added`, only `before` `removed`.
 */
export function diffGrids(before: PermissionsGrid, after: PermissionsGrid): GridDiff {
  // `null` (no group) apart from a group named "null".
  const columns = union(before.groups, after.groups, (group) => JSON.stringify(group));
  const at = (grid: PermissionsGrid) => columns.map((group) => grid.groups.indexOf(group));
  const beforeAt = at(before);
  const afterAt = at(after);
  const counts: Record<CellChange, number> = { same: 0, looser: 0, tighter: 0, changed: 0, added: 0, removed: 0 };

  const rowOf = (was: PermissionsRow | undefined, now: PermissionsRow | undefined, ops?: DiffRow[]): DiffRow => {
    const cells = columns.map((_, i) => {
      const cell = { before: was?.cells[beforeAt[i]!], after: now?.cells[afterAt[i]!] };
      const change = compareAnswers(cell.before, cell.after);
      counts[change]++;
      return { ...cell, change };
    });
    const status = !was
      ? "added"
      : !now
        ? "removed"
        : cells.some((c) => c.change !== "same") || ops?.some((op) => op.status !== "same")
          ? "changed"
          : "same";
    const title = now?.title ?? was?.title;
    return { id: (now ?? was)!.id, ...(title !== undefined && { title }), status, cells, ...(ops && { ops }) };
  };

  /** Two lists of rows aligned by `key`, `after`'s order first. */
  const rowsOf = <R extends PermissionsRow>(was: Map<string, R>, now: Map<string, R>, row: (a?: R, b?: R) => DiffRow) =>
    union([...was.keys()], [...now.keys()], (key) => key).map((key) => row(was.get(key), now.get(key)));

  const workflows = rowsOf(byOccurrence(before.workflows), byOccurrence(after.workflows), (was, now) =>
    rowOf(
      was,
      now,
      rowsOf(byOccurrence(was?.ops ?? []), byOccurrence(now?.ops ?? []), (a, b) => rowOf(a, b)),
    ),
  );
  const ops = rowsOf(byOccurrence(before.ops), byOccurrence(after.ops), (a, b) => rowOf(a, b));
  const groups = columns.map((group, i) => ({
    group,
    status: beforeAt[i] === -1 ? ("added" as const) : afterAt[i] === -1 ? ("removed" as const) : ("same" as const),
  }));
  const changed = [...groups, ...workflows, ...ops].some((item) => item.status !== "same");
  return { groups, workflows, ops, changed, counts };
}

/**
 * The diff with its unchanged rows left out: a workflow stays when anything under it changed,
 * with only the operations that did. `maxRows` caps the lines (a workflow and each operation
 * under it are a line each), workflows first; a workflow changed only under it stays only with
 * room for one of its operations too.
 */
export function onlyChanged(diff: GridDiff, maxRows = Infinity): GridDiff {
  let left = maxRows;
  const take = (rows: DiffRow[]): DiffRow[] =>
    rows.flatMap((row) => {
      const ownSame = row.cells.every((c) => c.change === "same");
      if (row.status === "same" || left < (row.status === "changed" && ownSame ? 2 : 1)) return [];
      left--;
      return [row.ops ? { ...row, ops: take(row.ops) } : row];
    });
  return { ...diff, workflows: take(diff.workflows), ops: take(diff.ops) };
}

/** An answer in the grid's words: a hold names whom it asks. */
export const answerWords = (answer: PreviewAnswer): string =>
  answer.answer === "hold" && answer.approver ? `hold · ${approverLabel(answer.approver)}` : answer.answer;

/**
 * A cell in words, before → after ("hold · group admin → allow"); one answer when it is the same,
 * new or removed; nothing for a cell neither grid has (a removed row's, in a new column).
 */
export function cellWords({ before, after }: DiffCell): string {
  if (before && after && compareAnswers(before, after) !== "same")
    return `${answerWords(before)} → ${answerWords(after)}`;
  const answer = after ?? before;
  return answer ? answerWords(answer) : "";
}

/** What a change did to a cell, in a word. */
export const CHANGE_WORDS: Record<CellChange, string> = {
  same: "unchanged",
  looser: "loosened",
  tighter: "tightened",
  changed: "changed",
  added: "new",
  removed: "removed",
};

/** Whom a column is about, in words. */
export const someoneIn = (group: string | null) =>
  group === ANONYMOUS ? "anonymous" : `someone in ${group ?? "no group"}`;

/** A column's heading: the group's name, or what the two columns of no group are. */
export const columnLabel = (group: string | null) =>
  group === null ? "No group" : group === ANONYMOUS ? "Anonymous" : group;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The diff in one line's parts: how many cells loosened, tightened or changed, each new or
 * removed column by name, and how many rows are new or removed ("3 loosened · new column finance"),
 * a new or removed workflow one row with the operations under it.
 */
export function diffSummary(diff: GridDiff): string[] {
  const kept = diff.workflows.filter((w) => w.status === "same" || w.status === "changed");
  const rows = [...diff.workflows, ...kept.flatMap((w) => w.ops ?? []), ...diff.ops];
  const rowsThat = (status: DiffRow["status"]) => rows.filter((row) => row.status === status).length;
  return [
    ...(["looser", "tighter", "changed"] as const)
      .filter((change) => diff.counts[change] > 0)
      .map((change) => `${diff.counts[change]} ${CHANGE_WORDS[change]}`),
    ...diff.groups.filter((g) => g.status === "added").map((g) => `new column ${columnLabel(g.group)}`),
    ...diff.groups.filter((g) => g.status === "removed").map((g) => `removed column ${columnLabel(g.group)}`),
    ...(rowsThat("added") > 0 ? [count(rowsThat("added"), "new row")] : []),
    ...(rowsThat("removed") > 0 ? [count(rowsThat("removed"), "removed row")] : []),
  ];
}
