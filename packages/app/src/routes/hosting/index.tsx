import type { DriftReport, DriftResult, RunSummary } from "@sanoma-ai/workflows";
import type { ConfigDescription, DeclaredResource, ResourceProblem } from "@sanoma-ai/workflows/describe";
import { APPLY_WORKFLOW, DRIFT_WORKFLOW, exportSpan, isEnded, problemAt } from "@sanoma-ai/workflows/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { ScanIcon } from "@phosphor-icons/react/dist/csr/Scan";
import { type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { DRIFT_TONE } from "#/lib/tone.ts";
import { errorBodyOf, INFRA } from "../../api.ts";
import {
  CardHeading,
  CodePanel,
  CrumbHeader,
  ExternalLink,
  Fact,
  Facts,
  loadCode,
  Nothing,
  Notice,
  PanelCard,
  plural,
  Problems,
  SectionTitle,
  ShortId,
  ToneBadge,
  VendorLogo,
  When,
} from "../../components/common.tsx";
import { type Adopt, FieldDiff } from "../../components/field-diff.tsx";
import { GoLive, loadGoLive } from "../../components/go-live.tsx";
import { startRunFn } from "../../functions.ts";
import {
  configQuery,
  driftReportQuery,
  goLiveProgressQuery,
  HostingSearch,
  isPeople,
  RUNS_KEY,
  runLink,
  runsQuery,
  sourceQuery,
  useStartRun,
} from "../../queries.ts";

export const Route = createFileRoute("/hosting/")({
  validateSearch: HostingSearch,
  loader: async ({ context: { queryClient } }) => {
    if (!import.meta.env.SSR) void loadCode();
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const drift = driftOf(config);
    await Promise.all([drift && loadLastCheck(queryClient, drift), !slotsOf(config).live && loadGoLive(queryClient)]);
  },
  component: HostingPage,
});

/** The slots on top of Hosting, each a contract a resource type meets (`capabilities`), in the order they show. */
const SLOTS = [
  { capability: "source", title: "Repository" },
  { capability: "database", title: "Database" },
  { capability: "host", title: "Host" },
  { capability: "wakeup", title: "Wakeup" },
] as const;
type Slot = (typeof SLOTS)[number];

/**
 * Which declared resource fills each slot: the first whose type meets its contract, the
 * repository being the one the host names (its `refs`) when the host names one. Whether the
 * company is declared live: a host or a database is.
 */
function slotsOf(config: ConfigDescription) {
  const capabilities = new Map(config.resourceTypes.map((t) => [t.id, t.capabilities ?? []]));
  const meets = (r: DeclaredResource, capability: Slot["capability"]) =>
    capabilities.get(`${r.vendor}.${r.type}`)?.includes(capability) ?? false;
  const first = (capability: Slot["capability"]) => config.resources.find((r) => meets(r, capability));
  const host = first("host");
  const named = new Set(Object.values(host?.refs ?? {}));
  const filled = SLOTS.flatMap((slot) => {
    const resource =
      (slot.capability === "source" && config.resources.find((r) => named.has(r.id) && meets(r, "source"))) ||
      first(slot.capability);
    return resource ? [{ ...slot, resource }] : [];
  });
  return { filled, live: host !== undefined || first("database") !== undefined };
}

/** The built-in drift workflow's name, when the config has it: its connectors declare resource types. */
const driftOf = (config: ConfigDescription) => config.workflows.find((wf) => wf.name === DRIFT_WORKFLOW)?.name;

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
 * Where the company runs, and the rest of what the data files declare at vendors: the repository,
 * database, host and wakeup on top, each with the latest drift check's verdict; then every other
 * resource (people are on People, collections on Data), the lockfile's orphans and what is wrong
 * in the files; and the declaration itself in its file. While no host and no database are
 * declared, going live's steps show first.
 */
function HostingPage() {
  const { data: config } = useSuspenseQuery(configQuery());
  const drift = driftOf(config);
  return drift ? (
    <WithDrift config={config} drift={drift} />
  ) : (
    <Hosting config={config}>
      <Notice>This config's connectors declare no resource types, so there is nothing to check for drift.</Notice>
    </Hosting>
  );
}

function WithDrift({ config, drift }: { config: ConfigDescription; drift: string }) {
  const { latest, finished, error } = useLastCheck(drift);
  const checking = latest !== undefined && !isEnded(latest.status);
  return (
    <Hosting
      config={config}
      report={finished?.report}
      adopt={finished && { runId: finished.run.runId, drift }}
      action={
        <div className="flex flex-wrap gap-2">
          <ApplyButton />
          <RunDriftButton drift={drift} checking={checking} />
        </div>
      }
    >
      {error && <Notice variant="destructive">Could not refresh the drift checks: {error.message}</Notice>}
      <LastCheck latest={latest} finished={finished} checking={checking} />
    </Hosting>
  );
}

function Hosting({
  config,
  report,
  adopt,
  action,
  children,
}: {
  config: ConfigDescription;
  report?: DriftReport;
  adopt?: Adopt;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { resource: selected } = Route.useSearch();
  const slots = useMemo(() => slotsOf(config), [config]);
  const results = useMemo(() => new Map(report?.resources.map((r) => [r.id, r])), [report]);
  const rows = useMemo(() => {
    const inSlots = new Set(slots.filled.map((slot) => slot.resource.id));
    return rowsOf(config.resources, report).filter((row) => !inSlots.has(row.id) && !isPeople(row));
  }, [config.resources, report, slots]);
  const problems = useMemo(() => problemsOf(config.problems, report), [config.problems, report]);
  const titles = useMemo(() => new Map(config.resourceTypes.map((t) => [t.id, t.title])), [config.resourceTypes]);
  const chosen =
    config.resources.find((r) => r.id === selected) ??
    config.collections.find((c) => c.declared?.id === selected)?.declared;

  return (
    <>
      <CrumbHeader action={action} />
      {children}
      {!slots.live && <GoLive />}
      {slots.filled.length > 0 && (
        <div className="grid gap-(--gap-region) md:grid-cols-2 2xl:grid-cols-4">
          {slots.filled.map(({ title, capability, resource }) => (
            <SlotCard
              key={capability}
              title={title}
              resource={resource}
              typeTitle={titles.get(`${resource.vendor}.${resource.type}`)}
              result={results.get(resource.id)}
              selected={resource.id === selected}
              adopt={adopt}
            />
          ))}
        </div>
      )}
      {rows.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Other resources</SectionTitle>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Declared in</TableHead>
                  <TableHead>Bound to</TableHead>
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
                    adopt={adopt}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : (
        slots.filled.length === 0 &&
        slots.live && (
          <Nothing title="No resources declared">
            Declare them in data files under <code>resources/</code>, beside the config.
          </Nothing>
        )
      )}
      {config.orphans.length > 0 && <Orphans orphans={config.orphans} titles={titles} />}
      {problems.length > 0 && <Problems problems={problems} />}
      {chosen && <Declaration key={chosen.id} resource={chosen} />}
    </>
  );
}

/** The fields a slot's card shows of what its resource declares: the plain values, at most this many. */
const SLOT_FIELDS = 4;

/** A declared field's value as the card shows it, when it is a plain one. */
const plainValue = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/**
 * A slot's resource: its name (to its declaration), type, a few of its declared fields, its
 * binding, the latest check's verdict and the fields that differ; the host's with where the last
 * apply that made it says it answers.
 */
function SlotCard({
  title,
  resource,
  typeTitle,
  result,
  selected,
  adopt,
}: {
  title: string;
  resource: DeclaredResource;
  typeTitle: string | undefined;
  result: DriftResult | undefined;
  selected: boolean;
  adopt?: Adopt;
}) {
  const binding = result?.binding ?? resource.binding;
  const fields = Object.entries(resource.desired)
    .filter(([field]) => field !== "name")
    .flatMap(([field, value]) => {
      const shown = plainValue(value);
      return shown === undefined ? [] : [[field, shown] as const];
    })
    .slice(0, SLOT_FIELDS);
  return (
    <Card size="sm" data-state={selected ? "selected" : undefined} className="min-w-0">
      <CardHeader>
        <CardHeading>{title}</CardHeading>
        <CardAction>
          <DriftBadge result={result} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Facts>
          <Fact label="Name">
            <span className="inline-flex items-center gap-2">
              <VendorLogo vendor={resource.vendor} alt="" className="size-4" />
              <DeclarationLink id={resource.id}>{resource.name}</DeclarationLink>
            </span>
          </Fact>
          <Fact label="Type">
            {typeTitle ?? resource.type}{" "}
            <code className="text-xs text-muted-foreground">{`${resource.vendor}.${resource.type}`}</code>
          </Fact>
          {fields.map(([field, value]) => (
            <Fact key={field} label={field}>
              <code className="text-xs">{value}</code>
            </Fact>
          ))}
          <Fact label="Bound to">
            {binding ? (
              <ShortId id={binding} className="text-xs" />
            ) : (
              <span className="text-muted-foreground">unbound</span>
            )}
          </Fact>
          {resource.id === `${INFRA}#host` && <HostServes />}
        </Facts>
        {result?.error !== undefined ? (
          <p className="text-destructive">{result.error}</p>
        ) : (
          result && result.fields.length > 0 && <FieldDiff id={resource.id} fields={result.fields} adopt={adopt} />
        )}
      </CardContent>
    </Card>
  );
}

/** Where the host answers, from the last apply that made or changed it (going live's progress), once it does. */
function HostServes() {
  const { data } = useQuery(goLiveProgressQuery());
  const host = data?.host;
  if (!host) return null;
  return (
    <Fact label="Serves">
      <span className="inline-flex flex-wrap items-center gap-2">
        <ExternalLink href={host.url}>{host.url}</ExternalLink>
        <ToneBadge tone={host.healthy ? "ok" : "off"}>{host.healthy ? "healthy" : "not answering yet"}</ToneBadge>
      </span>
    </Fact>
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
          <RunLink run={finished.run}>run {finished.run.runId}</RunLink>
          {found && `: ${found}`}.
        </p>
      ) : (
        !checking && <p>Not checked for drift yet.</p>
      )}
      {checking && latest && (
        <p className="flex items-center gap-2">
          <Spinner /> Checking now, in <RunLink run={latest}>run {latest.runId}</RunLink>.
        </p>
      )}
      {failed && (
        <p className="text-destructive">
          The latest check <RunLink run={failed}>{failed.status}</RunLink>
          {failed.error && `: ${failed.error}`}.
        </p>
      )}
    </div>
  );
}

const RunLink = ({ run, children }: { run: Pick<RunSummary, "runId" | "workflow">; children: ReactNode }) => (
  <Link {...runLink(run)} className="text-foreground underline-offset-4 hover:underline">
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
      {busy ? <Spinner data-icon="inline-start" /> : <ScanIcon aria-hidden="true" data-icon="inline-start" />}
      Run drift
    </Button>
  );
}

/**
 * Starts the apply workflow on every declared resource: its plan waits for a person in the Inbox
 * wherever the policy holds a change. The config registers apply beside drift, so it is here too.
 */
function ApplyButton() {
  const start = useStartRun();
  return (
    <Button
      variant="outline"
      onClick={() => start.mutate({ workflow: APPLY_WORKFLOW, input: {} })}
      disabled={start.isPending}
    >
      {start.isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <PlayIcon aria-hidden="true" data-icon="inline-start" />
      )}
      Apply
    </Button>
  );
}

/** A declaration, by its id unless `children` name it, linking to it shown in its data file below the tables. */
const DeclarationLink = ({ id, children }: { id: string; children?: ReactNode }) => (
  <Link
    to="/hosting"
    search={{ resource: id }}
    replace
    resetScroll={false}
    className={children ? "underline-offset-4 hover:underline" : "font-mono text-xs underline-offset-4 hover:underline"}
  >
    {children ?? id}
  </Link>
);

/** A resource's row, and under it the fields that differ, or why it could not be read. */
function ResourceRow({
  row,
  title,
  selected,
  adopt,
}: {
  row: Row;
  title: string | undefined;
  selected: boolean;
  adopt?: Adopt;
}) {
  const { result } = row;
  // The last check's binding is the newer: the description's is the lockfile's when the app started.
  const binding = result?.binding ?? row.declared?.binding;
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
            <DeclarationLink id={row.id} />
          ) : (
            // Read by the last check, but not by the app when it started: its declaration is not at hand.
            <code className="text-xs">{row.id}</code>
          )}
        </TableCell>
        <TableCell>
          {binding ? (
            <ShortId id={binding} className="text-xs" />
          ) : (
            <span className="text-muted-foreground">unbound</span>
          )}
        </TableCell>
        <TableCell>
          <DriftBadge result={result} />
        </TableCell>
      </TableRow>
      {detail && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="whitespace-normal">
            {result.error === undefined ? (
              <FieldDiff id={row.id} fields={result.fields} adopt={adopt} />
            ) : (
              <p className="text-destructive">{result.error}</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The lockfile's bindings that no data file declares: apply asks of each whether to forget it or
 * delete its object at the vendor.
 */
function Orphans({ orphans, titles }: { orphans: ConfigDescription["orphans"]; titles: Map<string, string> }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Bound, no longer declared</SectionTitle>
      <p className="text-sm text-muted-foreground">
        The lockfile binds these, but no data file declares them. Apply asks whether to forget each binding or delete
        its object at the vendor.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Declared as</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Bound to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orphans.map((orphan) => (
              <TableRow key={orphan.key}>
                <TableCell>
                  <code className="text-xs">{orphan.key}</code>
                </TableCell>
                <TableCell>
                  {titles.get(orphan.type) ?? orphan.type}{" "}
                  <code className="text-xs text-muted-foreground">{orphan.type}</code>
                </TableCell>
                <TableCell>
                  <ShortId id={orphan.id} className="text-xs" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** The latest check's verdict on a resource; "not checked" when it was not in that check. */
function DriftBadge({ result }: { result: DriftResult | undefined }) {
  if (!result) return <ToneBadge tone="idle">not checked</ToneBadge>;
  const { status, fields, found } = result;
  return (
    <ToneBadge tone={DRIFT_TONE[status]}>
      {status === "drifted"
        ? `drifted: ${plural(fields.length, "field")}`
        : status === "absent" && found !== undefined
          ? "absent: found unbound"
          : status}
    </ToneBadge>
  );
}

/** A declaration's export in its data file, marked as its text gives it (`exportSpan`): a resource's or a collection's. */
function Declaration({ resource: { file, at } }: { resource: Pick<DeclaredResource, "file" | "at"> }) {
  const { data, error } = useQuery(sourceQuery(file));
  const source = data?.source;
  const highlight = useMemo(() => {
    const span = source ? exportSpan(source, at.export) : undefined;
    return span ? [span] : [];
  }, [source, at.export]);
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
        <Skeleton role="status" aria-label={`Loading ${file}`} className="h-(--pane-short)" />
      ) : data.source === null ? (
        <Notice variant="destructive">{file} can no longer be read.</Notice>
      ) : (
        <PanelCard>
          <CodePanel source={data.source} highlight={highlight} />
        </PanelCard>
      )}
    </section>
  );
}
