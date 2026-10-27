import type { RunStatus, RunSummary } from "@sanoma-ai/workflows";
import type { WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { RUN_STATUSES } from "@sanoma-ai/workflows/shared";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { memo, useState } from "react";
import { z } from "zod";
import { Badge } from "#/components/ui/badge.tsx";
import { Card } from "#/components/ui/card.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { countByWorkflow, usePending } from "#/lib/inbox.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { RUNS_LIMIT } from "../../api.ts";
import {
  ButtonLink,
  CrumbHeader,
  LinkTab,
  LinkTabs,
  Nothing,
  Notice,
  PolicyProblems,
  plural,
  ToneBadge,
  VendorLogo,
  When,
} from "../../components/common.tsx";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ChatButton } from "../../components/chat-button.tsx";
import { LinkRow, RunsTable } from "../../components/runs-table.tsx";
import { startsOf } from "../../components/workflow.tsx";
import {
  type CalledVendor,
  configQuery,
  lastRunsQuery,
  POLL_MS,
  runsQuery,
  runsRefetchInterval,
  vendorsByWorkflow,
  waitingRunsQuery,
} from "../../queries.ts";

/** The overview's filters (`?filter=`): every workflow, those waiting on you, those whose last run failed, the built-in. */
const WORKFLOW_FILTERS = ["all", "waiting", "failed", "builtin"] as const;
type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];

/**
 * `?view=runs` shows every run as a table, `?status=` and `?workflow=` (a workflow's name, as its
 * page links here) filtering it; anything else, a row per workflow, `?filter=` picking them.
 */
const HomeSearch = z.object({
  view: z.literal("runs").optional().catch(undefined),
  status: z.enum(RUN_STATUSES).optional().catch(undefined),
  workflow: z.string().optional().catch(undefined),
  filter: z.enum(WORKFLOW_FILTERS).optional().catch(undefined),
});

/**
 * The All runs table's runs: the latest of every workflow or of one, or the latest with a status.
 * Polled as a workflow's runs are.
 */
const allRunsQuery = (status: RunStatus | undefined, workflow: string | undefined) =>
  queryOptions({
    ...runsQuery({ status, workflow, limit: RUNS_LIMIT.default }),
    refetchInterval: runsRefetchInterval(POLL_MS),
  });

export const Route = createFileRoute("/workflows/")({
  validateSearch: HomeSearch,
  loaderDeps: ({ search: { view, status, workflow } }) => ({ view, status, workflow }),
  // The root route loads the config. The waiting runs and each workflow's last run count the
  // tabs and fill the table (the root loader has started the waiting runs: this waits for them);
  // All runs reads its own runs beside them.
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.query({ ...waitingRunsQuery(), staleTime: "static" }),
      queryClient.query({ ...lastRunsQuery(), staleTime: "static" }),
      deps.view === "runs" && queryClient.query({ ...allRunsQuery(deps.status, deps.workflow), staleTime: "static" }),
    ]);
  },
  // A table of several columns: the width there is.
  staticData: { wide: true },
  component: WorkflowsPage,
});

/** A tab's link lit only while the URL lacks what its search leaves `undefined`. */
const EXACT_SEARCH = { explicitUndefined: true } as const;

const FILTER_LABEL: Record<WorkflowFilter, string> = {
  all: "All",
  waiting: "Waiting on you",
  failed: "Failed last run",
  builtin: "Built-in",
};

/**
 * The overview: how many workflows, the config's version, New workflow; then the tabs, a filter
 * of the workflows each (`?filter=`, with how many it holds) and All runs (`?view=runs`); then
 * one card holding the tab's table.
 */
function WorkflowsPage() {
  const { view, status, workflow, filter = "all" } = Route.useSearch();
  const { data: config } = useSuspenseQuery(configQuery());
  const { pending, mine } = usePending();
  const yours = countByWorkflow(mine);
  const { data: last } = useSuspenseQuery(lastRunsQuery());
  const picks: Record<WorkflowFilter, (wf: WorkflowEntry) => boolean> = {
    all: () => true,
    waiting: (wf) => !!yours[wf.name],
    failed: (wf) => last[wf.name]?.status === "failed",
    builtin: (wf) => !!wf.builtin,
  };
  const runs = view === "runs";
  return (
    <>
      <CrumbHeader
        count={config.workflows.length}
        action={
          <ChatButton prompt="Make a workflow that ">
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New workflow
          </ChatButton>
        }
      >
        {/* The config's version, cut to a few characters: its whole hash in the tooltip. */}
        <span className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
          Version
          <code className="max-w-48 truncate" title={config.version}>
            {config.version}
          </code>
        </span>
        {/* With no policy there is no Permissions page to say so. */}
        {!config.policy.defined && (
          <span className="text-sm text-muted-foreground">No policy: every operation call is allowed</span>
        )}
      </CrumbHeader>
      {config.policy.problems && <PolicyProblems />}
      <LinkTabs label="Show" value={runs ? "runs" : filter}>
        {WORKFLOW_FILTERS.map((f) => (
          <LinkTab
            key={f}
            value={f}
            // All leaves the URL without `?filter=`.
            link={
              <Link
                to="/workflows"
                search={{ filter: f === "all" ? undefined : f, view: undefined }}
                // Lit only where the URL has no other filter, nor All runs' view.
                activeOptions={EXACT_SEARCH}
              />
            }
            count={config.workflows.filter(picks[f]).length}
          >
            {FILTER_LABEL[f]}
          </LinkTab>
        ))}
        <LinkTab value="runs" link={<Link to="/workflows" search={{ view: "runs" }} />}>
          All runs
        </LinkTab>
      </LinkTabs>
      {runs ? (
        <AllRuns status={status} workflow={workflow} />
      ) : (
        <Overview
          workflows={config.workflows.filter(picks[filter])}
          none={config.workflows.length === 0}
          waiting={countByWorkflow(pending)}
          yours={yours}
          last={last}
        />
      )}
    </>
  );
}

/** Whether the workflow's title or name holds what was typed, whatever its case. */
const matches = (wf: WorkflowEntry, query: string) =>
  query === "" || `${wf.title ?? ""} ${wf.name}`.toLocaleLowerCase("en").includes(query.toLocaleLowerCase("en"));

/**
 * The workflows the tab picks as a table, in one card under a find box that filters them
 * by title or name, in the browser. Those whose runs wait on an approval you may decide come
 * first, then the rest by their last run, those never run last. A row: its title, how it starts,
 * the vendors it calls, its last run and how many approvals its runs wait on (yours among them).
 * The page reads each query in one pass and hands each row its share: a poll that changed one
 * row's run draws that row alone. `none` when the config has no workflows at all.
 */
function Overview({
  workflows,
  none,
  waiting,
  yours,
  last,
}: {
  workflows: WorkflowEntry[];
  none: boolean;
  waiting: Record<string, number>;
  yours: Record<string, number>;
  last: Record<string, RunSummary | undefined>;
}) {
  const [query, setQuery] = useState("");
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select: vendorsByWorkflow });
  if (none)
    return (
      <Card className="py-0">
        <Nothing className="border-0" title="This config has no workflows" />
      </Card>
    );
  const shown = workflows
    .filter((wf) => matches(wf, query.trim()))
    .toSorted(
      (a, b) =>
        (yours[b.name] ?? 0) - (yours[a.name] ?? 0) || (last[b.name]?.createdAt ?? 0) - (last[a.name]?.createdAt ?? 0),
    );
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 p-3">
        <div className="relative w-full max-w-64">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Find a workflow"
            placeholder="Find a workflow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <Nothing className="border-0 border-t" title="No workflow matches" />
      ) : (
        <Table className="border-t">
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Uses</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((wf) => (
              <WorkflowRow
                key={wf.name}
                workflow={wf}
                vendors={vendors[wf.name] ?? NO_VENDORS}
                last={last[wf.name]}
                waiting={waiting[wf.name] ?? 0}
                yours={yours[wf.name] ?? 0}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

const NO_VENDORS: CalledVendor[] = [];

/**
 * A workflow's row, opening its page: `waiting` approvals its runs wait on, `yours` of them for
 * you, which a waiting pill beside its title says.
 */
const WorkflowRow = memo(function WorkflowRow({
  workflow,
  vendors,
  last,
  waiting,
  yours,
}: {
  workflow: WorkflowEntry;
  vendors: CalledVendor[];
  /** Its latest run; none for a workflow never run. */
  last: RunSummary | undefined;
  waiting: number;
  yours: number;
}) {
  const { name } = workflow;
  return (
    <LinkRow link={{ to: "/workflows/$name", params: { name } }}>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/workflows/$name" params={{ name }} onClick={(e) => e.stopPropagation()}>
            {workflow.title ?? name}
          </Link>
          <code className="text-xs font-normal text-muted-foreground">{name}</code>
          {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
          {yours > 0 && (
            <ToneBadge tone="waiting" dot>
              {yours} waiting on you
            </ToneBadge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{startsOf(workflow.trigger)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {vendors.map((vendor) => (
            <Badge key={vendor.id} variant="outline">
              <VendorLogo vendor={vendor.id} alt="" className="size-3" />
              {vendor.title}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        {last ? (
          <span className="flex items-center gap-2">
            <ToneBadge tone={RUN_TONE[last.status]} dot>
              {last.status}
            </ToneBadge>
            <span className="text-muted-foreground">
              <When at={last.createdAt} />
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {waiting > 0 ? (
          // Every approval waiting, on anyone.
          <span className="tabular-nums">{plural(waiting, "approval")}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
    </LinkRow>
  );
});

/** Every workflow's latest runs as a table in the page's card, filtered by `?status=` and `?workflow=`. */
function AllRuns({ status, workflow }: { status: RunStatus | undefined; workflow: string | undefined }) {
  const navigate = Route.useNavigate();
  const { data: runs, error } = useSuspenseQuery(allRunsQuery(status, workflow));
  return (
    <>
      {error && <Notice variant="destructive">Could not refresh runs: {error.message}</Notice>}
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <NativeSelect
            size="sm"
            aria-label="Status"
            value={status ?? ""}
            // Another status replaces the page in the history rather than adding one; Any status
            // leaves the URL without `?status=`.
            onChange={(e) =>
              void navigate({
                search: (prev) => ({ ...prev, status: HomeSearch.shape.status.parse(e.target.value) }),
                replace: true,
              })
            }
          >
            <NativeSelectOption value="">Any status</NativeSelectOption>
            {RUN_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {s}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {/* The workflow's filter, as a link set it; its button removes it. */}
          {workflow !== undefined && (
            <Badge variant="outline" className="h-7 gap-1 pr-0.5">
              Workflow: <code>{workflow}</code>
              <ButtonLink variant="ghost" size="icon-xs" className="size-5">
                <Link to="." search={(prev) => ({ ...prev, workflow: undefined })} replace>
                  <XIcon aria-hidden="true" />
                  <span className="sr-only">Any workflow</span>
                </Link>
              </ButtonLink>
            </Badge>
          )}
        </div>
        {runs.length === 0 ? (
          <Nothing
            className="border-0 border-t"
            title={
              status ? "No runs with that status" : workflow !== undefined ? "No runs of that workflow" : "No runs yet"
            }
          />
        ) : (
          <RunsTable runs={runs} className="border-t" />
        )}
        {runs.length === RUNS_LIMIT.default && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the latest {RUNS_LIMIT.default}</p>
        )}
      </Card>
    </>
  );
}
