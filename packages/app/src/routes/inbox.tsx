import type { ApprovalState, RunSummary } from "@sanoma/workflows";
import type { ConfigDescription, OpEntry } from "@sanoma/workflows/describe";
import { mayDecide } from "@sanoma/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { APPROVAL_TONE } from "#/lib/tone.ts";
import { useActor } from "../actor.ts";
import { RUNS_LIMIT, starterName } from "../api.ts";
import { ApprovalCard } from "../components/approval.tsx";
import {
  Nothing,
  Notice,
  PageHeader,
  pageTitle,
  plural,
  Segment,
  Segmented,
  StatusDot,
  When,
} from "../components/common.tsx";
import {
  approvalKey,
  configQuery,
  decidedOf,
  type InboxFilter,
  InboxSearch,
  opsById,
  pendingOf,
  recentRunsQuery,
  runLink,
  waitingRunsQuery,
  workflowNamed,
} from "../queries.ts";

export const Route = createFileRoute("/inbox")({
  validateSearch: InboxSearch,
  loaderDeps: ({ search: { show } }) => ({ decided: show === "decided" }),
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.query({ ...waitingRunsQuery(), staleTime: "static" }),
      deps.decided && queryClient.query({ ...recentRunsQuery(), staleTime: "static" }),
    ]);
  },
  staticData: { crumb: "Inbox" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: InboxPage,
});

/** An approval with its run, as the Inbox lists it. */
type Entry = { run: RunSummary; approval: ApprovalState };

/**
 * The approvals `?show=` picks, newest first, beside the one `?approval=` opens. Without `?show=`,
 * those for you while the page knows who you are, else every pending one.
 */
function InboxPage() {
  const { show, approval: wanted } = Route.useSearch();
  const { actor, groups } = useActor();
  const { data: pending, error } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingOf });
  // A group approver counts only when the deployment vouches for groups: a typed name has none.
  const mine = actor ? pending.filter(({ approval }) => mayDecide(approval, { id: actor, groups: [...groups] })) : [];
  const filter = show ?? (actor ? "mine" : "waiting");
  const shown = filter === "mine" ? mine : pending;

  return (
    <>
      <PageHeader />
      {error && <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>}
      <Filters filter={filter} mine={actor ? mine.length : undefined} waiting={pending.length} />
      {filter === "decided" ? (
        <Decided wanted={wanted} />
      ) : shown.length === 0 ? (
        <Nothing title={pending.length === 0 ? "Nothing is waiting for a decision" : "Nothing is waiting for you"}>
          {pending.length > 0 && `${plural(pending.length, "approval")} waiting on others, under All waiting.`}
        </Nothing>
      ) : (
        // The one named, if it is still pending (here or under another filter); else the first
        // for you, else the first. A decision drops it from the list, so the next one opens.
        <Split
          entries={shown}
          show={show}
          open={find(shown, wanted) ?? find(pending, wanted) ?? mine[0] ?? shown[0]!}
        />
      )}
    </>
  );
}

/** The approvals decided in the latest runs, latest decision first. */
function Decided({ wanted }: { wanted: string | undefined }) {
  const { data: decided, error } = useSuspenseQuery({ ...recentRunsQuery(), select: decidedOf });
  return (
    <>
      {error && <Notice variant="destructive">Could not refresh the decided approvals: {error.message}</Notice>}
      {decided.length === 0 ? (
        <Nothing title={`No decisions in the latest ${RUNS_LIMIT.default} runs`} />
      ) : (
        <Split
          entries={decided}
          show="decided"
          open={find(decided, wanted) ?? decided[0]!}
          footer={`From the latest ${RUNS_LIMIT.default} runs`}
        />
      )}
    </>
  );
}

const find = (entries: Entry[], key: string | undefined) =>
  key === undefined ? undefined : entries.find((entry) => approvalKey(entry) === key);

const FILTER_LABEL: Record<InboxFilter, string> = { mine: "For you", waiting: "All waiting", decided: "Decided" };

/**
 * For you, All waiting and Decided, each with how many it lists, as links: a filter drops
 * `?approval=`, so its own first opens. The one shown is marked even when the URL names none.
 */
function Filters({ filter, mine, waiting }: { filter: InboxFilter; mine: number | undefined; waiting: number }) {
  const counts: Record<InboxFilter, number | undefined> = { mine, waiting, decided: undefined };
  return (
    <Segmented label="Show">
      {(Object.keys(FILTER_LABEL) as InboxFilter[]).map((f) => (
        <Segment key={f}>
          <Link to="/inbox" search={{ show: f }} aria-current={f === filter ? "page" : undefined}>
            {FILTER_LABEL[f]}
            {counts[f] !== undefined && ` · ${counts[f]}`}
          </Link>
        </Segment>
      ))}
    </Segmented>
  );
}

/** A row of the list; `aria-current` marks the approval open beside it. */
const ROW =
  "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted aria-[current=page]:bg-muted compact:py-1";

/** Each workflow's title (its name when it has none), by name: for `select`. */
const workflowTitles = (config: ConfigDescription) =>
  Object.fromEntries(config.workflows.map((wf) => [wf.name, wf.title ?? wf.name]));

/** The list beside the open approval, which stacks above it below `lg`. */
function Split({
  entries,
  show,
  open,
  footer,
}: {
  entries: Entry[];
  /** The URL's `?show=`, which the rows keep. */
  show: InboxFilter | undefined;
  open: Entry;
  footer?: string;
}) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  const openKey = approvalKey(open);
  return (
    <div className="grid grid-cols-1 items-start gap-(--gap-region) lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <nav aria-label="Approvals" className="flex flex-col gap-2 rounded-lg border bg-card p-2 text-card-foreground">
        <ul className="flex max-h-72 flex-col overflow-y-auto lg:max-h-[70vh]">
          {entries.map((entry) => {
            const { run, approval } = entry;
            const key = approvalKey(entry);
            return (
              <li key={key}>
                <Link
                  to="/inbox"
                  search={{ show, approval: key }}
                  aria-current={key === openKey ? "page" : undefined}
                  className={ROW}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot tone={APPROVAL_TONE[approval.status]} />
                    <span className="truncate font-medium">{approval.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      <When at={approval.decidedAt ?? approval.requestedAt} />
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {titles[run.workflow] ?? run.workflow} · from {starterName(run)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        {footer && <p className="px-2 text-xs text-muted-foreground">{footer}</p>}
      </nav>
      <section aria-label={open.approval.title} className="flex min-w-0 flex-col gap-(--gap-section)">
        <Asks {...open} />
        <ApprovalCard key={openKey} run={open.run} approval={open.approval} showRun />
      </section>
    </div>
  );
}

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/** An operation as something to do: "publish a post in Ghost". Its id when the config no longer has it. */
function doing(id: string, op: OpEntry | undefined, config: ConfigDescription) {
  if (!op) return `call ${id}`;
  const resource = op.resource.replaceAll("_", " ");
  return `${op.name} ${/^[aeiou]/i.test(resource) ? "an" : "a"} ${resource} in ${config.vendors[op.vendor]?.title ?? op.vendor}`;
}

/** The approval in a sentence: whose run of which workflow wants to do what. */
function Asks({ run, approval }: Entry) {
  const { data: config } = useSuspenseQuery(configQuery());
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const pending = approval.status === "pending";
  const what =
    approval.covers.length > 0
      ? `${pending ? "wants" : "wanted"} to ${AND.format(approval.covers.map((id) => doing(id, ops.get(id), config)))}`
      : `${pending ? "is waiting on" : "waited on"} this decision`;
  return (
    <p className="text-muted-foreground">
      <Link {...runLink(run)}>{run.startedBy ? `${run.startedBy.id}'s run` : "A run"}</Link> of{" "}
      <Link to="/workflows/$name" params={{ name: run.workflow }}>
        {workflowNamed(run.workflow)(config)?.title ?? run.workflow}
      </Link>{" "}
      {what}.
    </p>
  );
}
