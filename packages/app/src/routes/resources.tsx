import type { DriftField, DriftResult } from "@sanoma/workflows";
import type { ConfigDescription, DeclaredResource, ResourceProblem } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChevronRightIcon, CircleAlertIcon, ScanSearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { DRIFT_TONE } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import { type ResourcesView, errorBodyOf } from "../api.ts";
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
import { startDriftFn } from "../functions.ts";
import { configQuery, dataFileQuery, resourcesQuery, RUNS_KEY } from "../queries.ts";

export const Route = createFileRoute("/resources")({
  // `resource` names the resource whose declaration the source view shows.
  validateSearch: z.object({ resource: z.string().optional() }),
  staticData: { crumb: "Resources" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: async ({ context }) => {
    if (!import.meta.env.SSR) void loadCode();
    await context.queryClient.query({ ...resourcesQuery(), staleTime: "static" });
  },
  component: ResourcesPage,
});

/** Each resource type's title, by `<vendor>.<type>`: for `select`. */
const typeTitles = (config: ConfigDescription) => new Map(config.resourceTypes.map((t) => [t.id, t.title]));

/** The data file a resource is declared in, from its id (`<file>#<export>`). */
const fileOf = (id: string) => id.slice(0, id.lastIndexOf("#"));

/**
 * What the data files declare, beside what the vendors hold: each resource with the latest drift
 * check's verdict and the fields that differ, what is wrong in the files, and the declaration
 * itself in its file.
 */
function ResourcesPage() {
  const { data: view, error } = useSuspenseQuery(resourcesQuery());
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: typeTitles });
  const { resource: selected } = Route.useSearch();
  const results = useMemo(() => new Map(view.lastReport?.report.resources.map((r) => [r.id, r])), [view.lastReport]);
  const checking = view.latest !== null && !isEnded(view.latest.status);
  const chosen = view.resources.find((r) => r.id === selected);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader action={view.canDrift && <RunDriftButton checking={checking} />} />
      {error && <Notice variant="destructive">Could not refresh the resources: {error.message}</Notice>}
      {view.problems.length > 0 && <Problems problems={view.problems} />}
      {view.canDrift ? (
        <LastCheck view={view} checking={checking} />
      ) : (
        <Notice>This config's connectors declare no resource types, so there is nothing to check for drift.</Notice>
      )}
      {view.resources.length === 0 ? (
        <Nothing title="No resources declared">
          Declare them in data files under <code>resources/</code>, beside the config.
        </Nothing>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Differences</span>
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Declared in</TableHead>
                <TableHead>Drift</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.resources.map((resource) => (
                <ResourceRow
                  key={resource.id}
                  resource={resource}
                  title={titles.get(`${resource.vendor}.${resource.type}`)}
                  result={results.get(resource.id)}
                  selected={resource.id === selected}
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
              {p.file && <code>{`${p.file}:${p.line}:${p.column}`}</code>} {p.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** When the resources were last checked, by which run, what it found, and a check under way. */
function LastCheck({ view: { latest, lastReport }, checking }: { view: ResourcesView; checking: boolean }) {
  const counts = useMemo(() => {
    const by = new Map<string, number>();
    for (const r of lastReport?.report.resources ?? []) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return [...by].map(([status, n]) => `${n} ${status}`).join(", ");
  }, [lastReport]);
  const failed = latest && !checking && latest.status !== "finished" ? latest : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {lastReport ? (
        <p>
          Last checked <When at={lastReport.report.finishedAt} />, by{" "}
          <RunLink runId={lastReport.runId}>run {lastReport.runId}</RunLink>
          {counts && `: ${counts}`}.
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

/** Starts a drift check of the data files as they are now, then refreshes the page. */
function RunDriftButton({ checking }: { checking: boolean }) {
  const queryClient = useQueryClient();
  const start = useServerFn(startDriftFn);
  const mutation = useMutation({
    mutationFn: () => start(),
    onSuccess: async () => {
      toast.success("Checking the resources for drift");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: resourcesQuery().queryKey }),
        queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
      ]);
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

/** A resource's row, and under it, open at first, the fields that differ or why it could not be read. */
function ResourceRow({
  resource,
  title,
  result,
  selected,
}: {
  resource: DeclaredResource;
  title: string | undefined;
  result: DriftResult | undefined;
  selected: boolean;
}) {
  const [open, setOpen] = useState(true);
  const detail = result !== undefined && (result.fields.length > 0 || result.error !== undefined);
  return (
    <>
      <TableRow data-state={selected ? "selected" : undefined}>
        <TableCell>
          {detail && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={open}
              aria-label={open ? `Hide ${resource.name}'s differences` : `Show ${resource.name}'s differences`}
              onClick={() => setOpen(!open)}
            >
              <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
            </Button>
          )}
        </TableCell>
        <TableCell className="font-medium">
          <span className="inline-flex items-center gap-2">
            <VendorLogo vendor={resource.vendor} alt="" className="size-4" />
            {resource.name}
          </span>
        </TableCell>
        <TableCell>
          {title ?? resource.type}{" "}
          <code className="text-xs text-muted-foreground">{`${resource.vendor}.${resource.type}`}</code>
        </TableCell>
        <TableCell>
          <Link
            to="/resources"
            search={{ resource: resource.id }}
            replace
            resetScroll={false}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {resource.id}
          </Link>
        </TableCell>
        <TableCell>
          <DriftBadge result={result} />
        </TableCell>
      </TableRow>
      {detail && open && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
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
function Declaration({ resource }: { resource: DeclaredResource }) {
  const file = fileOf(resource.id);
  const { data, error } = useQuery(dataFileQuery(file));
  const highlight = useMemo(() => [resource.span], [resource.span]);
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
