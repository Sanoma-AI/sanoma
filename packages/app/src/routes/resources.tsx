import type { DriftField, DriftReport, DriftResult, RunSummary } from "@sanoma/workflows";
import type { ConfigDescription, DeclaredResource, ResourceProblem } from "@sanoma/workflows/describe";
import { isEnded, problemAt } from "@sanoma/workflows/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CircleAlertIcon, ScanSearchIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { DRIFT_TONE } from "#/lib/tone.ts";
import { errorBodyOf } from "../api.ts";
import {
  CodePanel,
  loadCode,
  Nothing,
  Notice,
  PageHeader,
  pageTitle,
  plural,
  SectionTitle,
  ToneBadge,
  VendorLogo,
  When,
} from "../components/common.tsx";
import { startRunFn } from "../functions.ts";
import { configQuery, driftReportQuery, RUNS_KEY, runsQuery, sourceQuery } from "../queries.ts";

export const Route = createFileRoute("/resources")({
  // `resource` names the resource whose declaration the source view shows.
  validateSearch: z.object({ resource: z.string().optional() }),
  staticData: { crumb: "Resources" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: async ({ context: { queryClient } }) => {
    if (!import.meta.env.SSR) void loadCode();
    const drift = driftOf(await queryClient.query({ ...configQuery(), staleTime: "static" }));
    if (drift) await loadLastCheck(queryClient, drift);
  },
  component: ResourcesPage,
});

/** The built-in drift workflow's name, when the config has it: its connectors declare resource types. */
const driftOf = (config: ConfigDescription) => config.workflows.find((wf) => wf.builtin)?.name;

/** The latest drift run, whatever its status. */
const latestQuery = (drift: string) => runsQuery({ workflow: drift, limit: 1 });
/** The latest drift run that finished. */
const finishedQuery = (drift: string) => runsQuery({ workflow: drift, status: "finished", limit: 1 });

/** The latest drift run, and the latest finished one's report, into the query client: for the loader. */
async function loadLastCheck(queryClient: QueryClient, drift: string) {
  const [latest] = await queryClient.query({ ...latestQuery(drift), staleTime: "static" });
  const [finished] =
    latest === undefined || latest.status === "finished"
      ? [latest]
      : await queryClient.query({ ...finishedQuery(drift), staleTime: "static" });
  if (finished) await queryClient.query({ ...driftReportQuery(finished.runId), staleTime: "static" });
}

/** The latest drift run, and the latest finished one with its report: shared with every list of runs, and polled. */
function useLastCheck(drift: string) {
  const { data: [latest] = [], error } = useQuery(latestQuery(drift));
  const { data: [lastFinished] = [] } = useQuery({
    ...finishedQuery(drift),
    enabled: latest !== undefined && latest.status !== "finished",
  });
  const finished = latest?.status === "finished" ? latest : lastFinished;
  const { data: report } = useQuery({ ...driftReportQuery(finished?.runId ?? ""), enabled: finished !== undefined });
  return { latest, finished: finished && report ? { run: finished, report } : undefined, error };
}

/** A row of the table: a resource the description declares, the last check's result on it, or both. */
interface Row {
  id: string;
  vendor: string;
  type: string;
  name: string;
  declared?: DeclaredResource;
  result?: DriftResult;
}

/**
 * The description's resources, as the app read the data files when it started, then any the
 * last check read that it does not have (a data file changed since), each with its result.
 */
function rowsOf(resources: DeclaredResource[], report: DriftReport | undefined): Row[] {
  const results = new Map(report?.resources.map((r) => [r.id, r]));
  const rows: Row[] = resources.map((declared) => ({ ...declared, declared, result: results.get(declared.id) }));
  const known = new Set(resources.map((r) => r.id));
  for (const result of report?.resources ?? []) if (!known.has(result.id)) rows.push({ ...result, result });
  return rows;
}

/** A problem, as text: where it is and what it says. */
const problemKey = (p: ResourceProblem) => `${problemAt(p) ?? ""} ${p.message}`;

/** The description's problems, then any other the last check found. */
function problemsOf(problems: ResourceProblem[], report: DriftReport | undefined): ResourceProblem[] {
  const seen = new Set(problems.map(problemKey));
  return [...problems, ...(report?.problems ?? []).filter((p) => !seen.has(problemKey(p)))];
}

/**
 * What the data files declare, beside what the vendors hold: each resource with the latest drift
 * check's verdict and the fields that differ, what is wrong in the files, and the declaration
 * itself in its file.
 */
function ResourcesPage() {
  const { data: config } = useSuspenseQuery(configQuery());
  const drift = driftOf(config);
  return drift ? (
    <WithDrift config={config} drift={drift} />
  ) : (
    <Resources config={config}>
      <Notice>This config's connectors declare no resource types, so there is nothing to check for drift.</Notice>
    </Resources>
  );
}

function WithDrift({ config, drift }: { config: ConfigDescription; drift: string }) {
  const { latest, finished, error } = useLastCheck(drift);
  const checking = latest !== undefined && !isEnded(latest.status);
  return (
    <Resources config={config} report={finished?.report} action={<RunDriftButton drift={drift} checking={checking} />}>
      {error && <Notice variant="destructive">Could not refresh the drift checks: {error.message}</Notice>}
      <LastCheck latest={latest} finished={finished} checking={checking} />
    </Resources>
  );
}

function Resources({
  config,
  report,
  action,
  children,
}: {
  config: ConfigDescription;
  report?: DriftReport;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { resource: selected } = Route.useSearch();
  const rows = useMemo(() => rowsOf(config.resources, report), [config.resources, report]);
  const problems = useMemo(() => problemsOf(config.problems, report), [config.problems, report]);
  const titles = useMemo(() => new Map(config.resourceTypes.map((t) => [t.id, t.title])), [config.resourceTypes]);
  const chosen = config.resources.find((r) => r.id === selected);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader action={action} />
      {problems.length > 0 && <Problems problems={problems} />}
      {children}
      {rows.length === 0 ? (
        <Nothing title="No resources declared">
          Declare them in data files under <code>resources/</code>, beside the config.
        </Nothing>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Declared in</TableHead>
                <TableHead>Drift</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ResourceRow
                  key={row.id}
                  row={row}
                  title={titles.get(`${row.vendor}.${row.type}`)}
                  selected={row.id === selected}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {chosen && <Declaration key={chosen.id} resource={chosen} />}
    </div>
  );
}

/** What is wrong in the data files: their resources are left out until it is fixed. */
function Problems({ problems }: { problems: ResourceProblem[] }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{plural(problems.length, "problem")} in the data files: their resources are left out</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {problems.map((p, i) => (
            // Two problems may share a place and a message: the list never reorders.
            <li key={i}>
              {p.file && <code>{problemAt(p)}</code>} {p.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** When the resources were last checked, by which run, what it found, and a check under way. */
function LastCheck({
  latest,
  finished,
  checking,
}: {
  latest: RunSummary | undefined;
  finished: { run: RunSummary; report: DriftReport } | undefined;
  checking: boolean;
}) {
  const counts = new Map<string, number>();
  for (const r of finished?.report.resources ?? []) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const found = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
  const failed = latest && !checking && latest.status !== "finished" ? latest : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {finished ? (
        <p>
          Last checked <When at={finished.report.finishedAt} />, by{" "}
          <RunLink runId={finished.run.runId}>run {finished.run.runId}</RunLink>
          {found && `: ${found}`}.
        </p>
      ) : (
        !checking && <p>Not checked for drift yet.</p>
      )}
      {checking && latest && (
        <p className="flex items-center gap-2">
          <Spinner /> Checking now, in <RunLink runId={latest.runId}>run {latest.runId}</RunLink>.
        </p>
      )}
      {failed && (
        <p className="text-destructive">
          The latest check <RunLink runId={failed.runId}>{failed.status}</RunLink>
          {failed.error && `: ${failed.error}`}.
        </p>
      )}
    </div>
  );
}

const RunLink = ({ runId, children }: { runId: string; children: ReactNode }) => (
  <Link to="/runs/$id" params={{ id: runId }} className="text-foreground underline-offset-4 hover:underline">
    {children}
  </Link>
);

/** Starts the drift workflow, as any workflow starts, on the data files as they are now. */
function RunDriftButton({ drift, checking }: { drift: string; checking: boolean }) {
  const queryClient = useQueryClient();
  const start = useServerFn(startRunFn);
  const mutation = useMutation({
    mutationFn: () => start({ data: { workflow: drift, input: {} } }),
    onSuccess: async () => {
      toast.success("Checking the resources for drift");
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  const busy = checking || mutation.isPending;
  return (
    <Button onClick={() => mutation.mutate()} disabled={busy}>
      {busy ? <Spinner data-icon="inline-start" /> : <ScanSearchIcon data-icon="inline-start" />}
      Run drift
    </Button>
  );
}

/** A resource's row, and under it the fields that differ, or why it could not be read. */
function ResourceRow({ row, title, selected }: { row: Row; title: string | undefined; selected: boolean }) {
  const { result } = row;
  const detail = result !== undefined && (result.fields.length > 0 || result.error !== undefined);
  return (
    <>
      <TableRow data-state={selected ? "selected" : undefined}>
        <TableCell className="font-medium">
          <span className="inline-flex items-center gap-2">
            <VendorLogo vendor={row.vendor} alt="" className="size-4" />
            {row.name}
          </span>
        </TableCell>
        <TableCell>
          {title ?? row.type} <code className="text-xs text-muted-foreground">{`${row.vendor}.${row.type}`}</code>
        </TableCell>
        <TableCell>
          {row.declared ? (
            <Link
              to="/resources"
              search={{ resource: row.id }}
              replace
              resetScroll={false}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {row.id}
            </Link>
          ) : (
            // Read by the last check, but not by the app when it started: its declaration is not at hand.
            <code className="text-xs">{row.id}</code>
          )}
        </TableCell>
        <TableCell>
          <DriftBadge result={result} />
        </TableCell>
      </TableRow>
      {detail && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="whitespace-normal">
            {result.error === undefined ? (
              <FieldDiff fields={result.fields} />
            ) : (
              <p className="text-destructive">{result.error}</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** The latest check's verdict on a resource; "not checked" when it was not in that check. */
function DriftBadge({ result }: { result: DriftResult | undefined }) {
  if (!result) return <ToneBadge tone="idle">not checked</ToneBadge>;
  const { status, fields } = result;
  return (
    <ToneBadge tone={DRIFT_TONE[status]}>
      {status === "drifted" ? `drifted: ${plural(fields.length, "field")}` : status}
    </ToneBadge>
  );
}

/** Each declared field that differs: what the data file declares, and what the vendor holds. */
function FieldDiff({ fields }: { fields: DriftField[] }) {
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead>Declared</TableHead>
          <TableHead>At the vendor</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field.path}>
            <TableCell>
              <code>{field.path}</code>
            </TableCell>
            <TableCell className="whitespace-pre-wrap">
              <code>{JSON.stringify(field.desired)}</code>
            </TableCell>
            <TableCell className="whitespace-pre-wrap">
              <code>{JSON.stringify(field.actual)}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The resource's `export const` in its data file, marked. */
function Declaration({ resource: { file, span } }: { resource: DeclaredResource }) {
  const { data, error } = useQuery(sourceQuery(file));
  const highlight = useMemo(() => [span], [span]);
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>
        <code>{file}</code>
      </SectionTitle>
      {error ? (
        <Notice variant="destructive">
          Could not read {file}: {error.message}
        </Notice>
      ) : data === undefined ? (
        <Skeleton role="status" aria-label={`Loading ${file}`} className="h-[280px]" />
      ) : data.source === null ? (
        <Notice variant="destructive">{file} can no longer be read.</Notice>
      ) : (
        <CodePanel source={data.source} highlight={highlight} className="h-[280px] sm:h-[360px]" />
      )}
    </section>
  );
}
