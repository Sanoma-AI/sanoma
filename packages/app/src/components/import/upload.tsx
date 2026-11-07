import { FileCsvIcon } from "@phosphor-icons/react/dist/csr/FileCsv";
import { type DragEvent, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { cn, plural } from "#/lib/utils.ts";
import { CardHeading, Notice } from "../kit.tsx";
import type { Sheet } from "./sheet.ts";

// The import's first step: a CSV file chosen or dropped, and the sheet's first rows as read.
// Presentational: the page reads the file (`readSheet`) and keeps the sheet.

/** How many of the sheet's rows Upload shows. */
const FIRST_ROWS = 5;

/** Choose or drop a file (`onFile`), see the first rows of the sheet read from it, then Match columns (`onNext`). */
export function Upload({
  sheet,
  refused,
  onFile,
  onNext,
}: {
  sheet: Sheet | undefined;
  /** Why the file chosen last was not read. */
  refused: string | undefined;
  onFile(file: File): void;
  onNext(): void;
}) {
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <Card aria-label="Upload a sheet" role="region">
      <CardHeader>
        <CardHeading>Upload a sheet</CardHeading>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
          className={cn(
            "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm",
            over && "border-ring bg-muted",
          )}
        >
          <FileCsvIcon aria-hidden="true" className="size-8 text-muted-foreground" />
          <span>Drop a CSV file here, or choose one</span>
          <span className="text-xs text-muted-foreground">
            Its first row names the columns. From Excel, save it as CSV UTF-8; from Sheets, download it as
            comma-separated values.
          </span>
          <input
            type="file"
            name="sheet"
            accept=".csv,text/csv"
            className="text-xs"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onFile(file);
            }}
          />
        </label>
        {refused && <Notice variant="destructive">{refused}</Notice>}
        {sheet && <FirstRows sheet={sheet} />}
      </CardContent>
      {sheet && (
        <CardFooter className="justify-end">
          <Button onClick={onNext} disabled={sheet.rows.length === 0}>
            Match columns
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

/** The sheet's header and its first rows, as read. */
function FirstRows({ sheet }: { sheet: Sheet }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        <span className="font-mono text-xs text-foreground">{sheet.file}</span> · {plural(sheet.rows.length, "row")} ·{" "}
        {plural(sheet.columns.length, "column")}
        {sheet.rows.length > FIRST_ROWS && `, the first ${FIRST_ROWS} shown`}
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table aria-label="The sheet's first rows">
          <TableHeader>
            <TableRow>
              {sheet.columns.map((column, i) => (
                <TableHead key={i}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.rows.slice(0, FIRST_ROWS).map((row, r) => (
              <TableRow key={r}>
                {sheet.columns.map((_, i) => (
                  <TableCell key={i}>{row[i]}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
