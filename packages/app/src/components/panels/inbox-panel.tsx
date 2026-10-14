import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link, useSearch } from "@tanstack/react-router";
import { memo, Suspense } from "react";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "#/components/ui/sidebar.tsx";
import { type Entry, useDecided, useInbox } from "#/lib/inbox.ts";
import { APPROVAL_TONE } from "#/lib/tone.ts";
import { RUNS_LIMIT, starterName } from "../../api.ts";
import { approvalKey, configQuery, type InboxFilter, workflowTitles } from "../../queries.ts";
import { Notice, Segment, Segmented } from "../common.tsx";
import { ACTIVE, PanelEmpty, PanelFooterLink, PanelHeader, PanelRow } from "./panel.tsx";

// The Inbox's panel: the approvals waiting, for you or for everyone, and those decided today.

/**
 * For you and Everyone, each with how many it lists, as links (`?show=`), then the approvals the
 * one shown lists, the one open marked, and those decided today; or, on Decided, the approvals
 * decided in the latest runs. All decided, at the foot, opens Decided. A filter drops
 * `?approval=`, so its own first opens.
 */
export function InboxPanel() {
  // The Inbox's search; none on another page, where this panel peeks.
  const show = useSearch({ strict: false, select: (search) => search.show });
  const wanted = useSearch({ strict: false, select: (search) => search.approval });
  const { actor, pending, mine, filter, shown, open, error } = useInbox(show, wanted);
  const { data: titles } = useSuspenseQuery({ ...configQuery(), select: workflowTitles });
  const openKey = open && approvalKey(open);
  return (
    <>
      <PanelHeader title="Inbox">
        <Segmented label="Show">
          {(["mine", "waiting"] as const).map((f) => (
            <Segment key={f}>
              <Link to="/inbox" search={{ show: f }} aria-current={f === filter ? "page" : undefined}>
                {f === "mine" ? `For you${actor ? ` · ${mine.length}` : ""}` : `Everyone · ${pending.length}`}
              </Link>
            </Segment>
          ))}
        </Segmented>
      </PanelHeader>
      <SidebarContent>
        {error && (
          <div className="px-2">
            <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>
          </div>
        )}
        {filter === "decided" ? (
          <Decided titles={titles} wanted={wanted} />
        ) : (
          <>
            <Approvals
              label={filter === "mine" ? "Waiting on you" : "Waiting"}
              entries={shown}
              show={show}
              openKey={openKey}
              titles={titles}
              empty={filter === "mine" ? "Nothing is waiting for you" : "Nothing is waiting for a decision"}
            />
            {/* Today is the browser's: the server knows neither its clock nor its time zone. */}
            <ClientOnly>
              <Suspense fallback={null}>
                <DecidedToday titles={titles} />
              </Suspense>
            </ClientOnly>
          </>
        )}
      </SidebarContent>
      <PanelFooterLink link={<Link to="/inbox" search={{ show: "decided" }} activeProps={ACTIVE} />}>
        All decided
      </PanelFooterLink>
    </>
  );
}

/** On Decided: the approvals decided in the latest runs, the one open marked. */
function Decided({ titles, wanted }: { titles: Record<string, string>; wanted: string | undefined }) {
  const { decided, open } = useDecided(wanted);
  return (
    <Approvals
      label={`Decided in the latest ${RUNS_LIMIT.default} runs`}
      entries={decided}
      show="decided"
      openKey={open && approvalKey(open)}
      titles={titles}
      empty={`No decisions in the latest ${RUNS_LIMIT.default} runs`}
    />
  );
}

/** Off Decided, in the browser: the approvals decided since midnight in the latest runs, each opening on Decided. */
function DecidedToday({ titles }: { titles: Record<string, string> }) {
  const { decided } = useDecided(undefined);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = decided.filter(({ approval }) => (approval.decidedAt ?? approval.requestedAt) >= midnight);
  if (today.length === 0) return null;
  return <Approvals label="Decided today" entries={today} show="decided" titles={titles} />;
}

/** A group of approvals under `label`, each a row keeping `show`, the one `openKey` names marked; `empty` when there are none. */
function Approvals({
  label,
  entries,
  show,
  openKey,
  titles,
  empty,
}: {
  label: string;
  entries: Entry[];
  show: InboxFilter | undefined;
  openKey?: string | undefined;
  titles: Record<string, string>;
  empty?: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel render={<h3 />}>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        {entries.length === 0 ? (
          <PanelEmpty>{empty}</PanelEmpty>
        ) : (
          <SidebarMenu aria-label={label} className="gap-0.5">
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
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * An approval in the panel: its status and title, when it was asked or decided, then its workflow
 * (by title) and who started the run. `current` marks the one open in the page: the first opens
 * with no `?approval=`, which the link cannot tell. Memoised: the query shares an unchanged
 * entry's object across a poll, so only the rows that changed draw again.
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
  show: InboxFilter | undefined;
  workflow: string;
  current: boolean;
}) {
  const { run, approval } = entry;
  return (
    <PanelRow
      link={<Link to="/inbox" search={{ show, approval: id }} aria-current={current ? "page" : undefined} />}
      isActive={current}
      tone={APPROVAL_TONE[approval.status]}
      title={<span className="truncate">{approval.title}</span>}
      at={approval.decidedAt ?? approval.requestedAt}
      lines={[`${approval.status === "pending" ? "" : `${approval.status} · `}${workflow} · from ${starterName(run)}`]}
    />
  );
});
