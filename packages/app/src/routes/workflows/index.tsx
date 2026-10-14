import type { RunStatus, RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { RUN_STATUSES } from "@sanoma/workflows/shared";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { memo } from "react";
import { z } from "zod";
import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { RUN_TONE } from "#/lib/tone.ts";
import { RUNS_LIMIT } from "../../api.ts";
import {
  ButtonLink,
  Fact,
  Facts,
  Nothing,
  Notice,
  PageHeader,
  plural,
  Segment,
  Segmented,
  StatusDot,
  ToneBadge,
  VendorLogo,
  When,
} from "../../components/common.tsx";
import { NewWorkflowButton } from "../../components/new-workflow.tsx";
import { RunsTable } from "../../components/runs-table.tsx";
import {
  type CalledVendor,
  configQuery,
  lastRunByWorkflow,
  pendingByWorkflow,
  POLL_MS,
  recentRunsQuery,
  runsQuery,
  runsRefetchInterval,
  vendorsByWorkflow,
  waitingRunsQuery,
} from "../../queries.ts";

/** The overview's filters (`?filter=`): every workflow, those waiting on an approval, those whose last run failed, the built-in. */
const WORKFLOW_FILTERS = ["all", "waiting", "failed", "builtin"] as const;
type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];

/**
 * `?view=runs` shows every run as a table, `?status=` and `?workflow=` (a workflow's name, as its
 * panel links here) filtering it; anything else, a row per workflow, `?filter=` picking them.
 */
const HomeSearch = z.object({
  view: z.literal("runs").optional().catch(undefined),
  status: z.enum(RUN_STATUSES).optional().catch(undefined),
  workflow: z.string().optional().catch(undefined),
  filter: z.enum(WORKFLOW_FILTERS).optional().catch(undefined),
});

/**
 * The All runs table's runs: the latest of every workflow or of one, or the latest with a status.
 * Polled as a workflow's panel's runs are.
 */
const allRunsQuery = (status: RunStatus | undefined, workflow: string | undefined) =>
  queryOptions({
    ...runsQuery({ status, workflow, limit: RUNS_LIMIT.default }),
    refetchInterval: runsRefetchInterval(POLL_MS),
  });

export const Route = createFileRoute("/workflows/")({
  validateSearch: HomeSearch,
  loaderDeps: ({ search: { view, status, workflow } }) => ({ view, status, workflow }),
  // The root route loads the config. The waiting runs and the latest runs are the overview's
  // and the Workflows panel's (the root loader has started the waiting runs: this waits for them).
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.query({ ...waitingRunsQuery(), staleTime: "static" }),
      queryClient.query({ ...recentRunsQuery(), staleTime: "static" }),
      deps.view === "runs" && queryClient.query({ ...allRunsQuery(deps.status, deps.workflow), staleTime: "static" }),
    ]);
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { view, status, workflow, filter } = Route.useSearch();
  const { data: config } = useSuspenseQuery(configQuery());
  const runs = view === "runs";
  return (
    <>
      <PageHeader
        action={
          <div className="flex gap-2">
            <ButtonLink variant="outline" size="sm">
              {runs ? (
                <Link to="/workflows">All workflows</Link>
              ) : (
                <Link to="/workflows" search={{ view: "runs" }}>
                  All runs
                </Link>
              )}
            </ButtonLink>
            <NewWorkflowButton />
          </div>
        }
      >
        <span className="text-muted-foreground">
          {plural(config.workflows.length, "workflow")} in {config.appName}
        </span>
      </PageHeader>
      <ConfigFacts />
      {runs ? <AllRuns status={status} workflow={workflow} /> : <Overview filter={filter ?? "all"} />}
    </>
  );
}

function ConfigFacts() {
  const { data: config } = useSuspenseQuery(configQuery());
  return (
    <Card size="sm">
      <CardContent>
        <Facts>
          <Fact label="Version">
            <code>{config.version}</code>
          </Fact>
          <Fact label="Policy">
            {config.policy.defined ? (
              <>
                a policy checks every operation call
                {config.policy.version ? (
                  <>
                    {" "}
                    (version <code>{config.policy.version}</code>)
                  </>
                ) : (
                  " (no version named)"
                )}
              </>
            ) : (
              "allowAll: every operation call is allowed"
            )}
          </Fact>
        </Facts>
      </CardContent>
    </Card>
  );
}

const FILTER_LABEL: Record<WorkflowFilter, string> = {
  all: "All",
  waiting: "Waiting on you",
  failed: "Failed last run",
  builtin: "Built-in",
};

/**
 * Every workflow as a row: its title, how it starts, the vendors it calls, its last run (among the
 * latest runs) and how many approvals its runs wait on. The chips above pick them (`?filter=`),
 * each with how many it holds. It reads each query in one pass and hands each row its share: a
 * poll that changed one row's run draws that row alone.
 */
function Overview({ filter }: { filter: WorkflowFilter }) {
  const { data: workflows } = useSuspenseQuery({ ...configQuery(), select: (config) => config.workflows });
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select: vendorsByWorkflow });
  const { data: pending } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingByWorkflow });
  const { data: last } = useSuspenseQuery({ ...recentRunsQuery(), select: lastRunByWorkflow });
  const picks: Record<WorkflowFilter, (wf: WorkflowEntry) => boolean> = {
    all: () => true,
    waiting: (wf) => !!pending.byWorkflow[wf.name],
    failed: (wf) => last[wf.name]?.status === "failed",
    builtin: (wf) => !!wf.builtin,
  };
  if (workflows.length === 0) return <Nothing title="This config has no workflows" />;
  const shown = workflows.filter(picks[filter]);
  return (
    <div className="flex flex-col gap-(--gap-section)">
      <Segmented label="Show">
        {WORKFLOW_FILTERS.map((f) => (
          <Segment key={f}>
            {/* All leaves the URL without `?filter=`; Link marks the one that matches. */}
            <Link to="/workflows" search={{ filter: f === "all" ? undefined : f }} activeOptions={{ exact: true }}>
              {FILTER_LABEL[f]} · {workflows.filter(picks[f]).length}
            </Link>
          </Segment>
        ))}
      </Segmented>
      {shown.length === 0 ? (
        <Nothing title="No workflow matches" />
      ) : (
        <div className="rounded-lg border">
          <Table>
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
                  waiting={pending.byWorkflow[wf.name] ?? 0}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Last run: from the latest {RUNS_LIMIT.default} runs</p>
    </div>
  );
}

const NO_VENDORS: CalledVendor[] = [];

/** How a workflow starts. Every one starts by hand for now. */
const STARTS: Record<WorkflowEntry["trigger"], string> = { manual: "By hand" };

/** A workflow's row: the whole row opens its page; its title is the link, for the keyboard and a new tab. */
const WorkflowRow = memo(function WorkflowRow({
  workflow,
  vendors,
  last,
  waiting,
}: {
  workflow: WorkflowEntry;
  vendors: CalledVendor[];
  /** Its latest run among the latest runs; none, none there. */
  last: RunSummary | undefined;
  waiting: number;
}) {
  const { name } = workflow;
  const navigate = useNavigate();
  return (
    <TableRow className="cursor-pointer" onClick={() => void navigate({ to: "/workflows/$name", params: { name } })}>
      <TableCell className="font-medium">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/workflows/$name" params={{ name }} onClick={(e) => e.stopPropagation()}>
            {workflow.title ?? name}
          </Link>
          <code className="text-xs font-normal text-muted-foreground">{name}</code>
          {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{STARTS[workflow.trigger]}</TableCell>
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
            <StatusDot tone={RUN_TONE[last.status]} />
            {last.status}
            <span className="text-muted-foreground">
              · <When at={last.createdAt} />
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {waiting > 0 ? (
          <ToneBadge tone="waiting">{plural(waiting, "approval")}</ToneBadge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
    </TableRow>
  );
});

/** Every workflow's latest runs as a table, filtered by `?status=` and `?workflow=`. */
function AllRuns({ status, workflow }: { status: RunStatus | undefined; workflow: string | undefined }) {
  const navigate = Route.useNavigate();
  const { data: runs, error } = useSuspenseQuery(allRunsQuery(status, workflow));
  return (
    <div className="flex flex-col gap-(--gap-section)">
      <div className="flex flex-wrap items-center gap-2">
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
        {/* The workflow's filter, as its panel's link set it; its button removes it. */}
        {workflow !== undefined && (
          <Badge variant="outline" className="h-7 gap-1 pr-0.5">
            Workflow: <code>{workflow}</code>
            <ButtonLink variant="ghost" size="icon-xs" className="size-5">
              <Link to="." search={(prev) => ({ ...prev, workflow: undefined })} replace>
                <XIcon />
                <span className="sr-only">Any workflow</span>
              </Link>
            </ButtonLink>
          </Badge>
        )}
      </div>
      {error && <Notice variant="destructive">Could not refresh runs: {error.message}</Notice>}
      {runs.length === 0 ? (
        <Nothing
          title={
            status ? "No runs with that status" : workflow !== undefined ? "No runs of that workflow" : "No runs yet"
          }
        />
      ) : (
        <RunsTable runs={runs} />
      )}
      {runs.length === RUNS_LIMIT.default && (
        <p className="text-xs text-muted-foreground">Showing the latest {RUNS_LIMIT.default}</p>
      )}
    </div>
  );
}
