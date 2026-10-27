import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type ChangeRef, filesOf, groupFiles } from "#/lib/changes.ts";
import { diffGrids, diffSummary } from "#/lib/grid-diff.ts";
import { changeQuery, permissionsQuery } from "../queries.ts";

/**
 * A change at a glance, in an approval's card (the Inbox's Publish): how many files of each kind
 * it edits, from the approval's own facts, and, once the change and main's Permissions grid have
 * been read in the browser, what it changes in the grid (`diffSummary`).
 */
export function ChangeGlance({ change }: { change: ChangeRef }) {
  const groups = groupFiles(filesOf(change.facts));
  // Read once for the grid: the glance does not follow the change as its page does.
  const { data: view } = useQuery({ ...changeQuery(change.change.id), refetchInterval: false });
  const { data: main } = useQuery(permissionsQuery());
  const branch = view?.state.check?.grid;
  const grid = useMemo(() => (main && branch ? diffSummary(diffGrids(main, branch)) : []), [main, branch]);
  return (
    <ul aria-label="What the change edits" className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {groups.map(({ key, title, files }) => (
        <li key={key}>
          {title} <span className="text-foreground tabular-nums">{files.length}</span>
        </li>
      ))}
      {grid.length > 0 && <li>Who may do what: {grid.join(" · ")}</li>}
    </ul>
  );
}
