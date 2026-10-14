import type { ApprovalState, RunSummary } from "@sanoma/workflows";
import type { ConfigDescription, OpEntry } from "@sanoma/workflows/describe";
import { mayDecide } from "@sanoma/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { memo } from "react";
import { ItemContent, ItemDescription, ItemTitle } from "#/components/ui/item.tsx";
import { APPROVAL_TONE } from "#/lib/tone.ts";
import { useActor } from "../actor.ts";
import { RUNS_LIMIT, starterName } from "../api.ts";
import { ApprovalCard } from "../components/approval.tsx";
import {
  ItemTime,
  LinkItem,
  Nothing,
  Notice,
  PageHeader,
  PaneList,
  pageTitle,
  plural,
  Segment,
  Segmented,
  StatusDot,
} from "../components/common.tsx";
import {
  approvalKey,
  configQuery,
  decidedOf,
  INBOX_FILTERS,
  type InboxFilter,
  InboxSearch,
  opsById,
  pendingOf,
  recentRunsQuery,
  runLink,
  waitingRunsQuery,
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
          description={`From the latest ${RUNS_LIMIT.default} runs`}
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
      {INBOX_FILTERS.map((f) => (
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

/** Each workflow's title (its name when it has none), by name: for `select`. */
const workflowTitles = (config: ConfigDescription) =>
  Object.fromEntries(config.workflows.map((wf) => [wf.name, wf.title ?? wf.name]));

/** The list beside the open approval, which stacks above it below `lg`. */
function Split({
  entries,
  show,
  open,
  description,
}: {
  entries: Entry[];
  /** The URL's `?show=`, which the rows keep. */
  show: InboxFilter | undefined;
  open: Entry;
  /** Under the list's title: where its approvals come from. */
  description?: string;
}) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  const openKey = approvalKey(open);
  return (
    <div className="grid grid-cols-1 items-start gap-(--gap-region) lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <nav aria-label="Approvals">
        <PaneList title="Approvals" description={description}>
          {entries.map((entry) => {
            const key = approvalKey(entry);
            return (
              <InboxRow
                key={key}
                id={key}
                entry={entry}
                show={show}
                workflow={titles[entry.run.workflow] ?? entry.run.workflow}
                current={key === openKey}
              />
            );
          })}
        </PaneList>
      </nav>
      <section aria-label={open.approval.title} className="flex min-w-0 flex-col gap-(--gap-section)">
        <Asks {...open} workflow={titles[open.run.workflow] ?? open.run.workflow} />
        <ApprovalCard key={openKey} run={open.run} approval={open.approval} showRun />
      </section>
    </div>
  );
}

/**
 * An approval in the list: its status and title, its workflow (by title) and who started the run,
 * and when it was asked or decided. `current` marks the one open beside the list. Memoised: the
 * query shares an unchanged entry's object across a poll, so only the rows that changed draw again.
 */
const InboxRow = memo(function InboxRow({
  id,
  entry,
  show,
  workflow,
  current,
}: {
  /** Its `approvalKey`, as the list already has it. */
  id: string;
  entry: Entry;
  show: InboxFilter | undefined;
  workflow: string;
  current: boolean;
}) {
  const { run, approval } = entry;
  return (
    <LinkItem size="xs">
      <Link to="/inbox" search={{ show, approval: id }} aria-current={current ? "page" : undefined}>
        {/* As the rail's runs: the content may shrink (min-w-0, max-w-full) and a long title is cut. */}
        <ItemContent className="min-w-0">
          <ItemTitle className="max-w-full">
            <StatusDot tone={APPROVAL_TONE[approval.status]} />
            <span className="truncate">{approval.title}</span>
          </ItemTitle>
          <ItemDescription>
            {approval.status !== "pending" && `${approval.status} · `}
            {workflow} · from {starterName(run)}
          </ItemDescription>
        </ItemContent>
        <ItemTime at={approval.decidedAt ?? approval.requestedAt} />
      </Link>
    </LinkItem>
  );
});

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * An operation as something to do: "publish a post in Ghost". Its id when the config no longer
 * has it. "an" before a, e, i or o only: a resource starting with u is more often "a user".
 */
function doing(id: string, op: OpEntry | undefined, config: ConfigDescription) {
  if (!op) return `call ${id}`;
  const resource = op.resource.replaceAll("_", " ");
  return `${op.name} ${/^[aeio]/i.test(resource) ? "an" : "a"} ${resource} in ${config.vendors[op.vendor]?.title ?? op.vendor}`;
}

/** The approval in a sentence: whose run of which workflow (its title) wants to do what. */
function Asks({ run, approval, workflow }: Entry & { workflow: string }) {
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
        {workflow}
      </Link>{" "}
      {what}.
    </p>
  );
}
