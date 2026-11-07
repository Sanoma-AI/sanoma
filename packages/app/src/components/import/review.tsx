import { IMPORT_BATCH } from "@sanoma-ai/workflows/shared";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { cn, plural } from "#/lib/utils.ts";
import { cellText } from "../grid/clipboard.ts";
import { CardHeading, ToneBadge } from "../kit.tsx";
import { countsOf, type Planned } from "./sheet.ts";

// The import's last step: what it will do with each row, as the run will (`planImport`), and the
// button that starts the run. Presentational: the page plans the rows and starts the run.

/** How many rows the preview lists; the counts are of all. */
const LISTED = 100;

/** What each kind of row is called in the Will column. */
const WILL: Record<Planned["will"], string> = { add: "add", update: "update", keep: "unchanged", fix: "fix first" };

/**
 * The counts (rows, will add, will update, unchanged, with problems), a table of the rows with
 * what each will do (a changed field showing what it was, a row to fix why), and Add n, update m
 * (`onImport`), which saves them in one run.
 */
export function Review({
  planned,
  fields,
  starting,
  onBack,
  onImport,
}: {
  planned: readonly Planned[];
  /** The fields the sheet fills, in its columns' order. */
  fields: readonly string[];
  /** The run is being started. */
  starting: boolean;
  onBack(): void;
  onImport(): void;
}) {
  const counts = countsOf(planned);
  const saves = counts.add + counts.update;
  return (
    <Card aria-label="What the import will do" role="region">
      <CardHeader className="flex flex-wrap items-center gap-3">
        <CardHeading>{plural(planned.length, "row")}</CardHeading>
        <ToneBadge tone="ok">{plural(counts.add, "new record")}</ToneBadge>
        <ToneBadge tone="waiting">{counts.update} update existing</ToneBadge>
        {counts.keep > 0 && <ToneBadge tone="idle">{counts.keep} unchanged</ToneBadge>}
        {counts.fix > 0 && <ToneBadge tone="bad">{counts.fix} with problems</ToneBadge>}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Import preview">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-right">Row</TableHead>
                <TableHead>Will</TableHead>
                {fields.map((field) => (
                  <TableHead key={field}>{field}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {planned.slice(0, LISTED).map((p) => (
                <TableRow key={p.row} className={cn(p.will === "add" && "bg-tone-ok/10 hover:bg-tone-ok/10")}>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{p.row}</TableCell>
                  <TableCell className={cn(p.will === "fix" ? "text-tone-bad-foreground" : "text-muted-foreground")}>
                    {WILL[p.will]}
                  </TableCell>
                  {p.will === "fix" ? (
                    <TableCell colSpan={fields.length} className="whitespace-normal">
                      {p.key !== undefined && <span className="mr-2 font-medium">{p.key}</span>}
                      <span className="text-muted-foreground">{p.reason}</span>
                    </TableCell>
                  ) : p.will === "keep" ? (
                    <TableCell colSpan={fields.length} className="font-medium">
                      {p.key}
                    </TableCell>
                  ) : (
                    fields.map((field) => <Cell key={field} planned={p} field={field} />)
                  )}
                </TableRow>
              ))}
              {planned.length > LISTED && (
                <TableRow>
                  <TableCell />
                  <TableCell colSpan={fields.length + 1} className="text-muted-foreground">
                    and {plural(planned.length - LISTED, "more row")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <span className="text-xs text-muted-foreground">
          Saved in one run as you, {IMPORT_BATCH} records at a time: the policy decides each save, and a held one waits
          for its approval in the Inbox.
        </span>
        <Button variant="ghost" className="ml-auto" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onImport} disabled={starting || saves === 0}>
          Add {counts.add}, update {counts.update}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** A field of a row to add or update: its value, and on an update what it was when that differs. */
function Cell({ planned, field }: { planned: Extract<Planned, { will: "add" | "update" }>; field: string }) {
  const value = cellText(planned.record[field]);
  const was = planned.will === "update" ? cellText(planned.was[field]) : value;
  return (
    <TableCell className={cn(was !== value && "bg-tone-waiting")}>
      {value || <span className="text-muted-foreground">-</span>}
      {was !== value && <span className="ml-1.5 text-xs text-muted-foreground">was {was || "empty"}</span>}
    </TableCell>
  );
}
