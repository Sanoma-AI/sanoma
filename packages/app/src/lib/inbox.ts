import type { ApprovalState, RunSummary } from "@sanoma-ai/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useActor } from "../actor.ts";
import { decidableBy } from "./decidable.ts";
import {
  approvalKey,
  configQuery,
  decidedOf,
  type InboxFilter,
  pendingOf,
  recentRunsQuery,
  waitingRunsQuery,
} from "../queries.ts";

// The Inbox's approvals, as its page reads them.

/** An approval with its run, as the Inbox lists it. */
export type Entry = { run: RunSummary; approval: ApprovalState };

/** The entry `?approval=` names, if it is among these. */
export const findEntry = (entries: Entry[], key: string | undefined) =>
  key === undefined ? undefined : entries.find((entry) => approvalKey(entry) === key);

/** The pending approvals, and those you may decide (`mine`), with the waiting runs' read's error. */
export function usePending() {
  const { actor, groups } = useActor();
  const { data: pending, error } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingOf });
  const { data: people } = useSuspenseQuery({ ...configQuery(), select: (config) => config.resources });
  return { actor, pending, mine: decidableBy(actor, groups, people)(pending), error };
}

/** How many of these approvals each workflow's runs wait on, by name. */
export const countByWorkflow = (entries: Entry[]) => {
  const counts: Record<string, number> = Object.create(null);
  for (const { run } of entries) counts[run.workflow] = (counts[run.workflow] ?? 0) + 1;
  return counts;
};

/**
 * The approvals pending, those you may decide (`mine`), what `?show=` lists (`filter`: without
 * it, those for you while the page knows who you are, else every pending one) and the one open:
 * the one `wanted` names while it is still pending (here or under the other filter); else the
 * first for you, else the first. None on Decided, which opens its own. The Inbox page lists them
 * and shows the open one over the list.
 */
export function useInbox(show: InboxFilter | undefined, wanted: string | undefined) {
  const { actor, pending, mine, error } = usePending();
  const filter: InboxFilter = show ?? (actor ? "mine" : "waiting");
  const shown = filter === "mine" ? mine : pending;
  const open =
    filter === "decided" ? undefined : (findEntry(shown, wanted) ?? findEntry(pending, wanted) ?? mine[0] ?? shown[0]);
  return { actor, pending, mine, filter, shown, open, error };
}

/** The approvals decided in the latest runs, latest decision first, and the one Decided opens: the one `wanted` names, else the latest. */
export function useDecided(wanted: string | undefined) {
  const { data: decided, error } = useSuspenseQuery({ ...recentRunsQuery(), select: decidedOf });
  return { decided, open: findEntry(decided, wanted) ?? decided[0], error };
}
