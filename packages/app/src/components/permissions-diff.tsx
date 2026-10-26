import type { PermissionsGrid } from "@sanoma-ai/workflows/describe";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card } from "#/components/ui/card.tsx";
import {
  answerWords,
  CHANGE_WORDS,
  cellWords,
  type DiffCell,
  type DiffRow,
  diffGrids,
  diffSummary,
  onlyChanged,
} from "#/lib/grid-diff.ts";
import { GRID_CHANGE_TONE } from "#/lib/tone.ts";
import { ToneBadge } from "./kit.tsx";
import { Mark, PermissionsTable } from "./permissions-grid.tsx";

/** An answer as a sentence says it: a hold, whom it asks. */
const spoken = (cell: DiffCell["before"]) => (!cell ? "nothing" : answerWords(cell).replace(" · ", " for "));

/**
 * A change to the Permissions grid, `before` (main's) against `after` (the branch's), in the grid's
 * own shape: a line of what changed, then only the rows that did, each changed cell in its
 * change's tone reading before → after, an unchanged one muted; Show unchanged rows shows the rest.
 * A new or removed workflow is no link: one of the two apps lacks its page.
 */
export function PermissionsDiff({ before, after }: { before: PermissionsGrid; after: PermissionsGrid }) {
  const diff = useMemo(() => diffGrids(before, after), [before, after]);
  const [all, setAll] = useState(false);
  const shown = all ? diff : onlyChanged(diff);
  const summary = diffSummary(diff);
  const empty = shown.workflows.length === 0 && shown.ops.length === 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {summary.length > 0 ? summary.join(" · ") : "No one's answers change"}
        </p>
        <Button variant="ghost" size="sm" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? "Hide unchanged rows" : "Show unchanged rows"}
        </Button>
      </div>
      {!empty && (
        <Card className="gap-0 py-0">
          <PermissionsTable<DiffRow>
            groups={shown.groups.map((g) => g.group)}
            workflows={shown.workflows}
            ops={shown.ops}
            cell={(row, i) => <DiffMark cell={row.cells[i]!} />}
            linkRow={(row) => row.status !== "added" && row.status !== "removed"}
          />
        </Card>
      )}
    </div>
  );
}

/** A diff's cell: unchanged, the grid's muted mark; changed, a badge in its change's tone, before → after. */
function DiffMark({ cell }: { cell: DiffCell }) {
  const answer = cell.after ?? cell.before;
  if (!answer) return null;
  if (cell.change === "same") return <Mark cell={answer} muted />;
  const label =
    cell.change === "added"
      ? `${CHANGE_WORDS.added}: ${spoken(cell.after)}`
      : cell.change === "removed"
        ? `${CHANGE_WORDS.removed}: ${spoken(cell.before)}`
        : `${CHANGE_WORDS[cell.change]}: ${spoken(cell.before)}, then ${spoken(cell.after)}`;
  return (
    <ToneBadge tone={GRID_CHANGE_TONE[cell.change]} aria-label={label}>
      {cellWords(cell)}
    </ToneBadge>
  );
}
