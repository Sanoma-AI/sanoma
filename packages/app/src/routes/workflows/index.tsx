import type { RunStatus } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FlaskConicalIcon } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { RUN_STATUSES, RUNS_LIMIT } from "../../api.ts";
import {
  Fact,
  Facts,
  GraphPanel,
  loadGraph,
  Nothing,
  Notice,
  PageHeader,
  plural,
  Section,
  ToneBadge,
  VendorLogo,
} from "../../components/common.tsx";
import { RunStrip } from "../../components/run-strip.tsx";
import { RunsTable } from "../../components/runs-table.tsx";
import { RunButton } from "../../components/workflow.tsx";
import { outlineGraph } from "../../graph/outline-graph.ts";
import {
  configQuery,
  opsById,
  pendingByWorkflow,
  runsQuery,
  scenariosFor,
  scenariosQuery,
  waitingRunsQuery,
} from "../../queries.ts";

/** `?view=runs` shows every run as a table, `?status=` filtering it; anything else, a card per workflow. */
const HomeSearch = z.object({
  view: z.enum(["workflows", "runs"]).optional().catch(undefined),
  status: z.enum(RUN_STATUSES).optional().catch(undefined),
});

/** The All runs table's runs: the latest of every workflow, or the latest with a status. */
const allRunsQuery = (status: RunStatus | undefined) => runsQuery({ status, limit: RUNS_LIMIT.default });

export const Route = createFileRoute("/workflows/")({
  validateSearch: HomeSearch,
  loaderDeps: ({ search: { view, status } }) => ({ view, status }),
  // The root route loads the config.
  loader: async ({ context: { queryClient }, deps }) => {
    if (deps.view === "runs") {
      await queryClient.query({ ...allRunsQuery(deps.status), staleTime: "static" });
      return;
    }
    if (!import.meta.env.SSR) void loadGraph();
    // The cards' Test links and waiting pills; their runs load in the browser (RunStrip), rather
    // than one read per card here. The root loader has started the waiting runs: this waits for them.
    await Promise.all([
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
      queryClient.query({ ...waitingRunsQuery(), staleTime: "static" }),
    ]);
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const { view, status } = Route.useSearch();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader />
      <ConfigFacts />
      <ViewToggle />
      {view === "runs" ? <AllRuns status={status} /> : <ByWorkflow />}
    </div>
  );
}

function ConfigFacts() {
  const { data: config } = useSuspenseQuery(configQuery());
  return (
    <Card size="sm">
      <CardContent>
        <Facts>
          <Fact label="App">{config.appName}</Fact>
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

/** The view's link while it shows: Link marks it `aria-current="page"`. */
const VIEW_LINK = "aria-[current=page]:bg-muted aria-[current=page]:font-semibold";

/** By workflow or All runs: two links, so each view has its own URL. */
function ViewToggle() {
  return (
    <ButtonGroup aria-label="View">
      <Button asChild variant="outline" size="sm" className={VIEW_LINK}>
        {/* Exact: else it would match every search, `?view=runs` too. */}
        <Link to="/workflows" activeOptions={{ exact: true }}>
          By workflow
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm" className={VIEW_LINK}>
        <Link to="/workflows" search={{ view: "runs" }}>
          All runs
        </Link>
      </Button>
    </ButtonGroup>
  );
}

function ByWorkflow() {
  const { data: config } = useSuspenseQuery(configQuery());
  const { data: pending } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingByWorkflow });
  if (config.workflows.length === 0) return <Nothing title="This config has no workflows" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {config.workflows.map((wf) => (
        <WorkflowCard key={wf.name} workflow={wf} waiting={pending.byWorkflow[wf.name] ?? 0} />
      ))}
    </div>
  );
}

/** A workflow at a glance: the vendors it calls, its latest runs, what waits on people, and its outline. */
function WorkflowCard({ workflow, waiting }: { workflow: WorkflowEntry; waiting: number }) {
  const { name, outline } = workflow;
  const { data: config } = useSuspenseQuery(configQuery());
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const { data: scenario } = useSuspenseQuery({
    ...scenariosQuery(),
    select: (response) => scenariosFor(name)(response).scenarios[0]?.name,
  });
  // Each vendor once, in the order the workflow's operations first name it.
  const vendors = useMemo(
    () => [...new Set(workflow.ops.flatMap((id) => ops.get(id)?.vendor ?? []))],
    [workflow.ops, ops],
  );
  const graph = useMemo(() => ("nodes" in outline ? outlineGraph(outline.nodes) : undefined), [outline]);
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          <Link to="/workflows/$name" params={{ name }} className="hover:underline">
            {workflow.title ?? name}
          </Link>
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <code>{name}</code>
          {workflow.builtin && <Badge variant="secondary">built-in</Badge>}
          {vendors.map((vendor) => (
            <Badge key={vendor} variant="outline">
              <VendorLogo vendor={vendor} alt="" className="size-3" />
              {config.vendors[vendor]?.title ?? vendor}
            </Badge>
          ))}
        </CardDescription>
        <CardAction className="flex gap-2">
          {scenario !== undefined && (
            <Button asChild variant="outline" size="sm">
              <Link to="/workflows/$name/new" params={{ name }} search={{ scenario }}>
                <FlaskConicalIcon data-icon="inline-start" />
                Test
              </Link>
            </Button>
          )}
          <RunButton name={name} variant="outline" size="sm" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <RunStrip workflow={name} />
          {waiting > 0 && <ToneBadge tone="waiting">{plural(waiting, "approval")} waiting</ToneBadge>}
        </div>
        <Section title="Outline">
          <p className="text-muted-foreground">
            {"error" in outline
              ? outline.error
              : "Read from the body of run; the functions it calls are not shown, even those defined in it"}
          </p>
          {graph && <GraphPanel graph={graph} show="start" />}
        </Section>
      </CardContent>
    </Card>
  );
}

/** Every workflow's latest runs as a table, filtered by `?status=`. */
function AllRuns({ status }: { status: RunStatus | undefined }) {
  const navigate = Route.useNavigate();
  const { data: runs, error } = useSuspenseQuery(allRunsQuery(status));
  return (
    <div className="flex flex-col gap-4">
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
      {error && <Notice variant="destructive">Could not refresh runs: {error.message}</Notice>}
      {runs.length === 0 ? (
        <Nothing title={status ? "No runs with that status" : "No runs yet"} />
      ) : (
        <RunsTable runs={runs} />
      )}
      {runs.length === RUNS_LIMIT.default && (
        <p className="text-xs text-muted-foreground">Showing the latest {RUNS_LIMIT.default}</p>
      )}
    </div>
  );
}
