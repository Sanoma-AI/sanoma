import type { ConfigDescription, OpEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RUNS_LIMIT } from "../api.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Nothing, Notice, PageHeader, pageTitle, plural } from "../components/common.tsx";
import { type Entry, useDecided, useInbox, workflowTitles } from "../components/panels/inbox-panel.tsx";
import {
  approvalKey,
  configQuery,
  InboxSearch,
  opsById,
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

/**
 * The approval open: the one `?approval=` names, else the first for you, else the first that
 * `?show=` lists (`useInbox`), or on Decided the one named, else the latest. Its panel lists them
 * all beside the page, the open one marked.
 */
function InboxPage() {
  const { show, approval: wanted } = Route.useSearch();
  const { pending, filter, open, error } = useInbox(show, wanted);
  return (
    <>
      <PageHeader />
      {error && <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>}
      {filter === "decided" ? (
        <Decided wanted={wanted} />
      ) : open ? (
        <Opened entry={open} />
      ) : (
        <Nothing title={pending.length === 0 ? "Nothing is waiting for a decision" : "Nothing is waiting for you"}>
          {pending.length > 0 && `${plural(pending.length, "approval")} waiting on others, under Everyone.`}
        </Nothing>
      )}
    </>
  );
}

/** On Decided: the approval named, else the latest decided in the latest runs. */
function Decided({ wanted }: { wanted: string | undefined }) {
  const { open, error } = useDecided(wanted);
  return (
    <>
      {error && <Notice variant="destructive">Could not refresh the decided approvals: {error.message}</Notice>}
      {open ? <Opened entry={open} /> : <Nothing title={`No decisions in the latest ${RUNS_LIMIT.default} runs`} />}
    </>
  );
}

/** The approval open: what it asks, in a sentence, then its card. A decision drops it, so the next one opens. */
function Opened({ entry }: { entry: Entry }) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  return (
    <section aria-label={entry.approval.title} className="flex min-w-0 flex-col gap-(--gap-section)">
      <Asks {...entry} workflow={titles[entry.run.workflow] ?? entry.run.workflow} />
      <ApprovalCard key={approvalKey(entry)} run={entry.run} approval={entry.approval} showRun />
    </section>
  );
}

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
