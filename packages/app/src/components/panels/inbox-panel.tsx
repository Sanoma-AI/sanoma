import type { ApprovalState, RunSummary } from "@sanoma/workflows";
import type { ConfigDescription } from "@sanoma/workflows/describe";
import { mayDecide } from "@sanoma/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link, useSearch } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { memo, Suspense } from "react";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";
import { APPROVAL_TONE } from "#/lib/tone.ts";
import { useActor } from "../../actor.ts";
import { RUNS_LIMIT, starterName } from "../../api.ts";
import {
  approvalKey,
  configQuery,
  decidedOf,
  type InboxFilter,
  pendingOf,
  recentRunsQuery,
  waitingRunsQuery,
} from "../../queries.ts";
import { Notice, Segment, Segmented, StatusDot, When } from "../common.tsx";
import { PanelHeader, usePanelPlace } from "./panel.tsx";

// The Inbox's panel: the approvals waiting, for you or for everyone, and those decided today.

/** An approval with its run, as the Inbox lists it. */
export type Entry = { run: RunSummary; approval: ApprovalState };

/** The entry `?approval=` names, if it is among these. */
export const findEntry = (entries: Entry[], key: string | undefined) =>
  key === undefined ? undefined : entries.find((entry) => approvalKey(entry) === key);

/**
 * The approvals pending, those you may decide (`mine`; none while the page knows no name), what
 * `?show=` lists (`filter`: without it, those for you while the page knows who you are, else every
 * pending one) and the one open: the one `wanted` names while it is still pending (here or under
 * the other filter); else the first for you, else the first. None on Decided, which opens its own.
 * The Inbox page shows the open one; its panel lists the rest beside it.
 */
export function useInbox(show: InboxFilter | undefined, wanted: string | undefined) {
  const { actor, groups } = useActor();
  const { data: pending, error } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingOf });
  // A group approver counts only when the deployment vouches for groups: a typed name has none.
  const mine = actor ? pending.filter(({ approval }) => mayDecide(approval, { id: actor, groups: [...groups] })) : [];
  const filter: InboxFilter = show ?? (actor ? "mine" : "waiting");
  const shown = filter === "mine" ? mine : pending;
  const open =
    filter === "decided" ? undefined : (findEntry(shown, wanted) ?? findEntry(pending, wanted) ?? mine[0] ?? shown[0]);
  return { actor, pending, mine, filter, shown, open, error };
}

/** Each workflow's title (its name when it has none), by name: for `select`. */
export const workflowTitles = (config: ConfigDescription) =>
  Object.fromEntries(config.workflows.map((wf) => [wf.name, wf.title ?? wf.name]));

/** The approvals decided in the latest runs, latest decision first, and the one Decided opens: the one `wanted` names, else the latest. */
export function useDecided(wanted: string | undefined) {
  const { data: decided, error } = useSuspenseQuery({ ...recentRunsQuery(), select: decidedOf });
  return { decided, open: findEntry(decided, wanted) ?? decided[0], error };
}

/**
 * For you and Everyone, each with how many it lists, as links (`?show=`), then the approvals the
 * one shown lists, the one open marked, and those decided today; or, on Decided, the approvals
 * decided in the latest runs. All decided, at the foot, opens Decided. A filter drops
 * `?approval=`, so its own first opens.
 */
export function InboxPanel() {
  const { close } = usePanelPlace();
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
              <Link to="/inbox" search={{ show: f }} aria-current={f === filter ? "page" : undefined} onClick={close}>
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
          <Decided titles={titles} wanted={wanted} onClick={close} />
        ) : (
          <>
            <Approvals
              label={filter === "mine" ? "Waiting on you" : "Waiting"}
              entries={shown}
              show={show}
              openKey={openKey}
              titles={titles}
              onClick={close}
              empty={filter === "mine" ? "Nothing is waiting for you" : "Nothing is waiting for a decision"}
            />
            {/* Today is the browser's: the server knows neither its clock nor its time zone. */}
            <ClientOnly>
              <Suspense fallback={null}>
                <DecidedToday titles={titles} onClick={close} />
              </Suspense>
            </ClientOnly>
          </>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  to="/inbox"
                  search={{ show: "decided" }}
                  aria-current={filter === "decided" ? "page" : undefined}
                  onClick={close}
                />
              }
              isActive={filter === "decided"}
              className="text-muted-foreground"
            >
              <span>All decided</span>
              <ArrowRightIcon className="ml-auto" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

/** On Decided: the approvals decided in the latest runs, the one open marked. */
function Decided({
  titles,
  wanted,
  onClick,
}: {
  titles: Record<string, string>;
  wanted: string | undefined;
  onClick: () => void;
}) {
  const { decided, open } = useDecided(wanted);
  return (
    <Approvals
      label={`Decided in the latest ${RUNS_LIMIT.default} runs`}
      entries={decided}
      show="decided"
      openKey={open && approvalKey(open)}
      titles={titles}
      onClick={onClick}
      empty={`No decisions in the latest ${RUNS_LIMIT.default} runs`}
    />
  );
}

/** Off Decided, in the browser: the approvals decided since midnight in the latest runs, each opening on Decided. */
function DecidedToday({ titles, onClick }: { titles: Record<string, string>; onClick: () => void }) {
  const { decided } = useDecided(undefined);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = decided.filter(({ approval }) => (approval.decidedAt ?? approval.requestedAt) >= midnight);
  if (today.length === 0) return null;
  return <Approvals label="Decided today" entries={today} show="decided" titles={titles} onClick={onClick} />;
}

/** A group of approvals under `label`, each a row keeping `show`, the one `openKey` names marked; `empty` when there are none. */
function Approvals({
  label,
  entries,
  show,
  openKey,
  titles,
  onClick,
  empty,
}: {
  label: string;
  entries: Entry[];
  show: InboxFilter | undefined;
  openKey?: string | undefined;
  titles: Record<string, string>;
  onClick: () => void;
  empty?: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel render={<h3 />}>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        {entries.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{empty}</p>
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
                  onClick={onClick}
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
 * (by title) and who started the run. `current` marks the one open in the page. Memoised: the
 * query shares an unchanged entry's object across a poll, so only the rows that changed draw again.
 */
const InboxRow = memo(function InboxRow({
  id,
  entry,
  show,
  workflow,
  current,
  onClick,
}: {
  /** Its `approvalKey`, as the list already has it. */
  id: string;
  entry: Entry;
  /** The `?show=` its link keeps. */
  show: InboxFilter | undefined;
  workflow: string;
  current: boolean;
  onClick: () => void;
}) {
  const { run, approval } = entry;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current}
        className="h-auto flex-col items-stretch gap-0.5 py-1.5"
        render={
          <Link
            to="/inbox"
            search={{ show, approval: id }}
            aria-current={current ? "page" : undefined}
            onClick={onClick}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot tone={APPROVAL_TONE[approval.status]} />
          <span className="truncate">{approval.title}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            <When at={approval.decidedAt ?? approval.requestedAt} />
          </span>
        </span>
        {/* One line, as the title, so the rows keep one height. */}
        <span className="truncate pl-4.5 text-xs text-muted-foreground">
          {approval.status !== "pending" && `${approval.status} · `}
          {workflow} · from {starterName(run)}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
