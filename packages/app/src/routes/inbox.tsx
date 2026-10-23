import type { ConfigDescription, OpEntry } from "@sanoma-ai/workflows/describe";
import { WORKFLOW_ACTION } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import { memo, Suspense } from "react";
import { CardAction, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { cn } from "#/lib/utils.ts";
import { APPROVAL_TONE } from "#/lib/tone.ts";
import { RUNS_LIMIT, starterName } from "../api.ts";
import { ApprovalDecision, ApprovalDetails } from "../components/approval.tsx";
import {
  ApprovalStatusBadge,
  ButtonLink,
  CardHeading,
  CrumbHeader,
  FLOAT,
  FloatHost,
  FloatingCard,
  LinkTab,
  LinkTabs,
  Nothing,
  Notice,
  pageTitle,
  plural,
  StatusDot,
  When,
} from "../components/common.tsx";
import { type Entry, useDecided, useInbox } from "../lib/inbox.ts";
import {
  approvalKey,
  configQuery,
  type InboxFilter,
  InboxSearch,
  opsById,
  recentRunsQuery,
  runLink,
  waitingRunsQuery,
  workflowTitles,
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
  // The list beside the open approval takes the width there is.
  staticData: { crumb: "Inbox", wide: true },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: InboxPage,
});

/**
 * The Inbox: how many approvals wait, the tabs For you, Everyone and Decided (`?show=`, each a
 * link that drops `?approval=`, so its own first opens), then one card listing the approvals the
 * tab shows, the one open marked, and over its right the open approval: the one `?approval=`
 * names, else the first for you, else the first the tab lists (`useInbox`), or on Decided the one
 * named, else the latest decided. For you and Everyone list those decided today under them.
 */
function InboxPage() {
  const { show, approval: wanted } = Route.useSearch();
  const { actor, pending, mine, filter, shown, open, error } = useInbox(show, wanted);
  return (
    <>
      <CrumbHeader count={pending.length} />
      {error && <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>}
      <LinkTabs label="Show" value={filter}>
        <LinkTab
          value="mine"
          link={<Link to="/inbox" search={{ show: "mine" }} />}
          count={actor ? mine.length : undefined}
        >
          For you
        </LinkTab>
        <LinkTab value="waiting" link={<Link to="/inbox" search={{ show: "waiting" }} />} count={pending.length}>
          Everyone
        </LinkTab>
        <LinkTab value="decided" link={<Link to="/inbox" search={{ show: "decided" }} />}>
          Decided
        </LinkTab>
      </LinkTabs>
      {filter === "decided" ? (
        <Decided wanted={wanted} />
      ) : (
        <FloatHost float={open && <Opened key={approvalKey(open)} entry={open} />}>
          {shown.length === 0 ? (
            <Nothing
              className="border-0"
              title={
                filter === "mine" && pending.length > 0
                  ? "Nothing is waiting for you"
                  : "Nothing is waiting for a decision"
              }
              action={
                filter === "mine" &&
                pending.length > 0 && (
                  <ButtonLink variant="outline" size="sm">
                    <Link to="/inbox" search={{ show: "waiting" }}>
                      Show the {plural(pending.length, "approval")} waiting on others
                    </Link>
                  </ButtonLink>
                )
              }
            />
          ) : (
            <Approvals
              label={filter === "mine" ? "Waiting on you" : "Waiting"}
              entries={shown}
              show={filter}
              openKey={open && approvalKey(open)}
            />
          )}
          {/* Today is the browser's: the server knows neither its clock nor its time zone. */}
          <ClientOnly>
            <Suspense fallback={null}>
              <DecidedToday />
            </Suspense>
          </ClientOnly>
        </FloatHost>
      )}
    </>
  );
}

/** On Decided: the approvals decided in the latest runs, and the one named, else the latest, open over them. */
function Decided({ wanted }: { wanted: string | undefined }) {
  const { decided, open, error } = useDecided(wanted);
  return (
    <>
      {error && <Notice variant="destructive">Could not refresh the decided approvals: {error.message}</Notice>}
      <FloatHost float={open && <Opened key={approvalKey(open)} entry={open} />}>
        {decided.length === 0 ? (
          <Nothing className="border-0" title={`No decisions in the latest ${RUNS_LIMIT.default} runs`} />
        ) : (
          <Approvals
            label={`Decided in the latest ${RUNS_LIMIT.default} runs`}
            entries={decided}
            show="decided"
            openKey={open && approvalKey(open)}
          />
        )}
      </FloatHost>
    </>
  );
}

/** Off Decided, in the browser: the approvals decided since midnight in the latest runs, each opening on Decided. */
function DecidedToday() {
  const { decided } = useDecided(undefined);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = decided.filter(({ approval }) => (approval.decidedAt ?? approval.requestedAt) >= midnight);
  if (today.length === 0) return null;
  return <Approvals label="Decided today" entries={today} show="decided" />;
}

/** A group of approvals under `label`, each a row keeping `show`, the one `openKey` names marked. */
function Approvals({
  label,
  entries,
  show,
  openKey,
}: {
  label: string;
  entries: Entry[];
  show: InboxFilter;
  openKey?: string | undefined;
}) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  return (
    <section aria-label={label} className="flex flex-col">
      <h2 className="px-4 pt-3 pb-2 text-xs font-medium text-muted-foreground">{label}</h2>
      <ul className="divide-y border-y">
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
      </ul>
    </section>
  );
}

/**
 * An approval in the list: its status as a dot, its title, then its workflow (by title) and who
 * started the run, and when it was asked or decided at the end. `current` marks the one open: the
 * first opens with no `?approval=`, which the link cannot tell. Memoised: the query shares an
 * unchanged entry's object across a poll, so only the rows that changed draw again.
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
  /** The `?show=` its link keeps. */
  show: InboxFilter;
  workflow: string;
  current: boolean;
}) {
  const { run, approval } = entry;
  return (
    <li>
      <Link
        to="/inbox"
        search={{ show, approval: id }}
        aria-current={current ? "page" : undefined}
        className="flex items-start gap-3 px-4 py-2.5 outline-hidden hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:bg-muted"
      >
        <StatusDot tone={APPROVAL_TONE[approval.status]} className="mt-1.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{approval.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {approval.status === "pending" ? "" : `${approval.status} · `}
            {workflow} · from {starterName(run)}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          <When at={approval.decidedAt ?? approval.requestedAt} />
        </span>
      </Link>
    </li>
  );
});

/**
 * The approval open, floating over the right of the list's card: its title and status, what it
 * asks in a sentence, its details, and Approve and Reject while it is pending. A decision drops
 * it from the list, so the next one opens. Its body scrolls inside the card's height.
 */
function Opened({ entry }: { entry: Entry }) {
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  const { run, approval } = entry;
  return (
    <FloatingCard role="region" aria-label={approval.title} className={cn(FLOAT, "order-first")}>
      <CardHeader className="border-b">
        <CardHeading>{approval.title}</CardHeading>
        <CardAction>
          <ApprovalStatusBadge status={approval.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Asks {...entry} workflow={titles[run.workflow] ?? run.workflow} />
        <ApprovalDetails run={run} approval={approval} showRun />
      </CardContent>
      {approval.status === "pending" && (
        <CardFooter className="flex-wrap gap-2">
          <ApprovalDecision run={run} approval={approval} />
        </CardFooter>
      )}
    </FloatingCard>
  );
}

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * An operation as something to do: "publish a post in Ghost". Its id when the config no longer
 * has it. "an" before a, e, i or o only: a resource starting with u is more often "a user".
 */
function doing(id: string, op: OpEntry | undefined, config: ConfigDescription) {
  if (id.startsWith(WORKFLOW_ACTION)) return "start";
  if (!op) return `call ${id}`;
  const resource = op.resource.replaceAll("_", " ");
  return `${op.name} ${/^[aeio]/i.test(resource) ? "an" : "a"} ${resource} in ${config.vendors[op.vendor]?.title ?? op.vendor}`;
}

/**
 * The approval in a sentence: whose run of which workflow (its title) wants to do what (start,
 * for a start the policy holds), and the approval's title, with the policy's rules behind it.
 */
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
      {what}: “{approval.title}”
      {approval.reasons?.length ? (
        <>
          , by <code>{approval.reasons.join(", ")}</code>
        </>
      ) : null}
      .
    </p>
  );
}
