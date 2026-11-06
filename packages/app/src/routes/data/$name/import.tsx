import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import {
  errorMessage,
  IMPORT_WORKFLOW,
  type ImportInput,
  importRows,
  LIST_LIMIT,
  mappingProblems,
  personsOf,
  type Saved,
} from "@sanoma-ai/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { plural } from "#/lib/utils.ts";
import { useActor } from "../../../actor.ts";
import type { UntypedApi } from "../../../api-client.ts";
import { CrumbHeader, Notice, pageTitle } from "../../../components/common.tsx";
import { MatchColumns } from "../../../components/import/match.tsx";
import { Review } from "../../../components/import/review.tsx";
import { guessMapping, keyRange, planImport, readSheet, type Sheet } from "../../../components/import/sheet.ts";
import { Upload } from "../../../components/import/upload.tsx";
import { api, collectionNamed, configQuery, useStartRun } from "../../../queries.ts";

/** The import's steps after Upload, in the search so Back and Forward move between them: `?step=match`, `?step=review`. */
const ImportSearch = z.object({ step: z.enum(["match", "review"]).optional().catch(undefined) });

const STEPS = [
  ["upload", "Upload"],
  ["match", "Match columns"],
  ["review", "Review"],
] as const;

export const Route = createFileRoute("/data/$name/import")({
  validateSearch: ImportSearch,
  staticData: { crumb: "Import", wide: true },
  head: ({ params }) => pageTitle(`Import into ${params.name}`),
  component: ImportPage,
});

/**
 * A sheet imported into the collection, in three steps: Upload (a CSV file, its first rows),
 * Match columns (each column's field, the values to map, the rows the fields refuse) and Review
 * (what each row will do, read against the records there as you), whose Add n, update m starts a
 * run of the built-in `import` and opens it. The sheet is the page's: reloaded, it starts again.
 */
function ImportPage() {
  const { name } = Route.useParams();
  const { step } = Route.useSearch();
  const navigate = Route.useNavigate();
  const select = useMemo(
    () => (config: ConfigDescription) => ({
      collection: collectionNamed(name)(config),
      people: personsOf(config.resources),
    }),
    [name],
  );
  const {
    data: { collection, people },
  } = useSuspenseQuery({ ...configQuery(), select });
  if (!collection) throw notFound();
  const { actor } = useActor();
  const [sheet, setSheet] = useState<Sheet>();
  const [refused, setRefused] = useState<string>();
  const [mapping, setMapping] = useState<ImportInput["mapping"]>([]);
  const at = sheet ? (step ?? "upload") : "upload";
  const go = (next: "match" | "review" | undefined) => void navigate({ search: { step: next } });
  const input: ImportInput | undefined = sheet && {
    collection: name,
    mapping,
    rows: sheet.rows,
    people: people.map((person) => person.id),
  };
  const ready = input !== undefined && mappingProblems(collection, mapping).length === 0;
  const keys = ready ? importRows(collection, input).rows.map((row) => row.key) : [];
  const range = keyRange(keys);
  // The records the sheet's keys have, read as you: one range of keys, a page at a time.
  const found = useQuery({
    queryKey: ["data", name, "import", range ?? null],
    queryFn: async () => {
      const records = new Map<string, Saved>();
      const calls = (api as UntypedApi).data[name];
      let where: Record<string, unknown> = { [collection.key]: range };
      for (let more = range !== undefined; more;) {
        const page = (await calls.list({ where, limit: LIST_LIMIT.max })) as Saved[];
        for (const saved of page) records.set(saved.key, saved);
        more = page.length === LIST_LIMIT.max;
        where = { [collection.key]: { gt: page.at(-1)?.key, lte: range!.lte } };
      }
      return records;
    },
    enabled: at === "review" && ready && actor !== null,
  });
  const start = useStartRun();

  const read = async (file: File) => {
    setRefused(undefined);
    const got =
      /\.csv$/i.test(file.name) || file.type === "text/csv" ? readSheet(file.name, await file.text()) : undefined;
    if (!got) {
      setRefused(
        /\.xlsx?$/i.test(file.name)
          ? `${file.name} is a workbook: save it as CSV first (Excel's Save As › CSV UTF-8, Sheets' Download › Comma-separated values).`
          : `${file.name} is no CSV file with a header row.`,
      );
      return;
    }
    setSheet(got);
    setMapping(guessMapping(collection, got, people));
  };

  return (
    <>
      <CrumbHeader>
        {sheet && (
          <span className="text-sm text-muted-foreground">
            <span className="font-mono text-xs">{sheet.file}</span> · {plural(sheet.rows.length, "row")}
          </span>
        )}
        <ol aria-label="Steps" className="ml-auto flex gap-1.5 text-xs text-muted-foreground">
          {STEPS.map(([id, label], i) => (
            <li key={id} aria-current={id === at ? "step" : undefined} className="aria-[current=step]:text-foreground">
              {i + 1} {label}
              {i < STEPS.length - 1 && " ·"}
            </li>
          ))}
        </ol>
      </CrumbHeader>
      {actor === null ? (
        <Notice>Say who you are to import: the policy decides each save for the person asking.</Notice>
      ) : at === "upload" || !sheet || !input ? (
        <Upload sheet={sheet} refused={refused} onFile={(file) => void read(file)} onNext={() => go("match")} />
      ) : at === "match" ? (
        <MatchColumns
          collection={collection}
          sheet={sheet}
          mapping={mapping}
          people={people}
          onMapping={setMapping}
          onBack={() => go(undefined)}
          onNext={() => go("review")}
        />
      ) : !ready ? (
        <Notice variant="destructive">
          Match the columns first: {mappingProblems(collection, mapping).join("; ")}.
        </Notice>
      ) : found.isError ? (
        <Notice variant="destructive">{errorMessage(found.error)}</Notice>
      ) : found.data ? (
        <>
          {start.isError && <Notice variant="destructive">{errorMessage(start.error)}</Notice>}
          <Review
            planned={planImport(collection, input, found.data)}
            fields={mapping.flatMap((column) => (column ? [column.field] : []))}
            starting={start.isPending}
            onBack={() => go("match")}
            onImport={() => start.mutate({ workflow: IMPORT_WORKFLOW, input })}
          />
        </>
      ) : (
        <Skeleton role="status" aria-label="Reading the records" className="h-40 w-full" />
      )}
    </>
  );
}
