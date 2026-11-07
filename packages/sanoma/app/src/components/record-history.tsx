import { CALL_WORKFLOW, errorMessage } from "sanoma/workflows/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { GRID_CHANGE_TONE } from "#/lib/tone.ts";
import { useActor } from "../actor.ts";
import type { FieldChange, HistoryEntry } from "../api.ts";
import { historyQuery, openRecord, runLink } from "../queries.ts";
import { None, Notice, ToneBadge, When } from "./common.tsx";
import { Value } from "./data-grid.tsx";

// A record's history in its side panel, from the ledger (`getHistory`): one line per write,
// newest first, "<when> · <who> · <what changed>", and its run. Read as the person asking, whom
// the policy must let read the record.

/**
 * The record `recordKey`'s history: its writes, "No changes yet" before any, that older ones are
 * not shown when the ledger holds more, or why it cannot be read.
 */
export function RecordHistory({ name, recordKey }: { name: string; recordKey: string }) {
  const { actor } = useActor();
  // Every read is the policy's to decide as someone, as the records are.
  const history = useQuery({ ...historyQuery(name, recordKey), enabled: actor !== null });
  return (
    <section aria-label="History" className="flex flex-col gap-2 border-t pt-4 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">History · from the ledger</h3>
      {history.data ? (
        <>
          {history.data.writes.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {history.data.writes.map((entry, i) => (
                <HistoryLine key={i} entry={entry} you={actor} />
              ))}
            </ul>
          )}
          {history.data.more ? (
            <None>Older changes are not shown.</None>
          ) : (
            !history.data.writes.length && <None>No changes yet.</None>
          )}
        </>
      ) : history.isError ? (
        <Notice variant="destructive">{errorMessage(history.error)}</Notice>
      ) : (
        <Skeleton role="status" aria-label="Loading the history" className="h-12 w-full" />
      )}
    </section>
  );
}

/**
 * A write: when and who (a person's own call as the person, "you" for whoever is asking; a
 * workflow's run as the workflow), what it changed, and its run's page, but for a direct
 * write's, which has none (#230).
 */
function HistoryLine({ entry, you }: { entry: HistoryEntry; you: string | null | undefined }) {
  const who = entry.workflow !== CALL_WORKFLOW ? entry.workflow : entry.by === you ? "you" : entry.by;
  return (
    <li data-slot="history-line">
      <span className="text-muted-foreground">
        <When at={entry.at} /> · {who}
      </span>{" "}
      · <Change change={entry.change} />
      {!entry.runId.startsWith("direct:") && (
        <>
          {" · "}
          <Link {...runLink(entry)} className="text-muted-foreground underline-offset-4 hover:underline">
            run
          </Link>
        </>
      )}
    </li>
  );
}

/** What a write did: created or deleted, in a grid change's tone, or each field it changed, "field before → after". */
function Change({ change }: { change: HistoryEntry["change"] }) {
  if (change === "created") return <ToneBadge tone={GRID_CHANGE_TONE.added}>created</ToneBadge>;
  if (change === "deleted") return <ToneBadge tone={GRID_CHANGE_TONE.removed}>deleted</ToneBadge>;
  if (!change.length) return <span className="text-muted-foreground">saved as it was</span>;
  return change.map((field, i) => (
    <span key={field.field}>
      {i > 0 && ", "}
      <FieldLine change={field} />
    </span>
  ));
}

/** A field's change, "field before → after", or "field rewritten" when either value is longer than 40 characters. */
function FieldLine({ change: { field, before, after } }: { change: FieldChange }) {
  if ([before, after].some((value) => typeof value === "string" && value.length > 40)) return <>{field} rewritten</>;
  return (
    <>
      {field}{" "}
      <span className="text-muted-foreground">
        <Value value={before} /> →
      </span>{" "}
      <Value value={after} />
    </>
  );
}

/**
 * A saved toast's record, by its key, as a link to its history: the record open in the Data
 * page's side panel. The key itself, so the toast stays one line beside its Undo.
 */
export function HistoryLink({ name, recordKey }: { name: string; recordKey: string }) {
  return (
    <Link
      to="/data/$name"
      params={{ name }}
      search={openRecord(recordKey)}
      title="Its history, from the ledger"
      className="underline underline-offset-4"
    >
      {recordKey}
    </Link>
  );
}
