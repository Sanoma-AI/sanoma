import { CALL_WORKFLOW, errorMessage, type Saved } from "@sanoma-ai/workflows/shared";
import { deepEquals } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { CardContent, CardHeader } from "#/components/ui/card.tsx";
import { GRID_CHANGE_TONE } from "#/lib/tone.ts";
import { cn, plural } from "#/lib/utils.ts";
import { runLink } from "../../queries.ts";
import { CardHeading, FLOAT, FloatingCard, StatusDot, Tip, TipButton, ToneBadge } from "../common.tsx";
import { cellText } from "./clipboard.ts";
import type { CellChange, RecordsView, Staged, Step } from "./collection.ts";
import { type Conflict, conflictId } from "./conflicts.tsx";

// The change a paste, a fill, an edit of a selection, Delete or a new record stages, as the grid
// shows it (`useStagedChange`): from the staged transaction's mutations, each record's fields as
// they were and as staged (`changesOf`), and from its steps, the cells to fix first
// (`issuesOf`); the bar above the grid's footer, which counts them and saves or discards them;
// and the review card.

/** What a control that would lose the staged change says while it is disabled, and a gesture it refuses. */
export const STAGED_FIRST = "Save or discard the staged changes first";

/** A record the change saves: what it is called, how it changes, and each field it changes, as it was and as staged. */
export interface RecordChange {
  key: string;
  /** Its key, or for a new record what its key cell holds. */
  name: string;
  type: "insert" | "update" | "delete";
  fields: { field: string; before: unknown; after: unknown }[];
}

/** The records `staged` changes, from its transaction's mutations; an update that ends where it began is none. */
export function changesOf(staged: Staged | undefined, keyField: string): RecordChange[] {
  return (staged?.tx.mutations ?? []).flatMap((m) => {
    const before = m.type === "insert" ? {} : (m.original as Saved).record;
    const after = m.modified.record;
    const fields =
      m.type === "delete"
        ? []
        : [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter((field) => !deepEquals(before[field], after[field]))
            .map((field) => ({ field, before: before[field], after: after[field] }));
    if (m.type === "update" && fields.length === 0) return [];
    return [{ key: m.key, name: cellText(m.type === "insert" ? after[keyField] : m.key), type: m.type, fields }];
  });
}

/** A staged cell that cannot be saved as it is, and why. */
export interface CellIssue {
  key: string;
  field: string;
  error: string;
}

/**
 * The cells of `staged` to fix before it saves: each whose last change is text its field cannot
 * read; a new record's `required` fields while it has none, and its key while it has none, or
 * one a record has already (`taken`, or another new record's).
 */
export function issuesOf(
  staged: Staged | undefined,
  keyField: string,
  required: readonly string[],
  taken: (key: string) => boolean,
): CellIssue[] {
  if (!staged) return [];
  const live = new Set(staged.tx.mutations.flatMap((m) => (m.type === "delete" ? [] : [m.key])));
  const last = new Map<string, CellChange>();
  for (const step of staged.steps)
    for (const cell of step.cells ?? []) last.set(`${cell.key}\u0000${cell.field}`, cell);
  const issues = [...last.values()].flatMap(({ key, field, error }) =>
    error && live.has(key) ? [{ key, field, error }] : [],
  );
  const flagged = new Set(issues.map(conflictId));
  const inserts = staged.tx.mutations.filter((m) => m.type === "insert");
  const typedKeys = Map.groupBy(inserts, (m) => cellText(m.modified.record[keyField]));
  const flag = (key: string, field: string, error: string) => {
    if (!flagged.has(conflictId({ key, field }))) issues.push({ key, field, error });
  };
  for (const m of inserts) {
    const typed = cellText(m.modified.record[keyField]);
    if (typed === "") flag(m.key, keyField, "Needs a key");
    else if (taken(typed) || typedKeys.get(typed)!.length > 1) flag(m.key, keyField, "A record has this key already");
  }
  for (const m of inserts)
    for (const field of required)
      if (field !== keyField && m.modified.record[field] === undefined) flag(m.key, field, "Needs a value");
  return issues;
}

/** What the steps were, as the bar says them: "paste", "paste and fill". */
const whatOf = (staged: Staged) => {
  const whats = [...new Set(staged.steps.map((step) => step.what))];
  return whats.length > 1 ? `${whats.slice(0, -1).join(", ")} and ${whats.at(-1)}` : whats[0];
};

/** A staged change's numbers: its changes (cells changed, records added and deleted) in how many records. */
export function countsOf(changes: RecordChange[]) {
  const updated = changes.filter((c) => c.type === "update");
  const cells = updated.reduce((n, c) => n + c.fields.length, 0);
  const added = changes.filter((c) => c.type === "insert").length;
  const deleted = changes.filter((c) => c.type === "delete").length;
  return { changes: cells + added + deleted, records: changes.length, cells, updated: updated.length, added, deleted };
}

/**
 * The bar over the grid's footer while a change is staged: how many changes in how many
 * records, from which gestures, what to settle first, and Review, Discard and Save as one change
 * (which waits for the conflicts and the cells to fix).
 */
export function StagedBar({
  staged,
  counts,
  issues,
  conflicts,
  saving,
  onReview,
  onDiscard,
  onSave,
}: {
  staged: Staged;
  counts: ReturnType<typeof countsOf>;
  issues: number;
  conflicts: number;
  saving: boolean;
  onReview: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const parts = [
    counts.cells > 0 && `${plural(counts.cells, "cell")} changed in ${plural(counts.updated, "record")}`,
    counts.added > 0 && plural(counts.added, "new record"),
    counts.deleted > 0 && `${plural(counts.deleted, "record")} deleted`,
  ].filter(Boolean);
  const first = [
    conflicts > 0 && `${plural(conflicts, "conflict")} to settle first`,
    issues > 0 && `${plural(issues, "cell")} to fix first`,
  ].filter(Boolean);
  const blocked = first.length > 0;
  const save = (
    <Button size="sm" disabled={saving || blocked || counts.records === 0} onClick={onSave}>
      {saving ? "Saving…" : "Save as one change"}
    </Button>
  );
  return (
    <div
      role="region"
      aria-label="Staged changes"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-tone-waiting px-3 py-2 text-sm"
    >
      <span className="font-medium">
        {plural(counts.changes, "change")} in {plural(counts.records, "record")}
      </span>
      <span className="text-muted-foreground">
        from your {whatOf(staged)}
        {parts.length > 0 && `: ${parts.join(", ")}`}
        {first.map((text) => ` · ${text}`)}
      </span>
      <span className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" onClick={onReview}>
          Review
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
          Discard
        </Button>
        {blocked ? (
          <Tip tip="Settle the conflicts and fix the cells first, or Review to save the rest">{save}</Tip>
        ) : (
          save
        )}
      </span>
    </div>
  );
}

/** The bar once a change is held for an approval: how many records wait, and the run of `call` they wait in. */
export function HeldBar({ count, runId, onClose }: { count: number; runId: string | undefined; onClose: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-tone-waiting px-3 py-2 text-sm text-tone-waiting-foreground"
    >
      <span aria-hidden className="size-2.5 shrink-0 rounded-full border-2 border-tone-waiting-foreground" />
      <span>Your change of {plural(count, "record")} waits for approval</span>
      {runId && (
        <Link {...runLink({ workflow: CALL_WORKFLOW, runId })} className="underline underline-offset-4">
          Open the run
        </Link>
      )}
      <TipButton tip="Close" size="icon-sm" className="ml-auto" onClick={onClose}>
        <XIcon aria-hidden="true" />
      </TipButton>
    </div>
  );
}

/** How many records the review card lists before "and n more". */
const LISTED = 20;

/**
 * The review card, floating over the grid: the cells to fix first, then each record's changed
 * fields as they were and as staged, new and deleted records in their change's tone, and Save n
 * now, which saves the records ready (neither in conflict nor with a cell to fix) and leaves the
 * rest staged.
 */
export function ReviewCard({
  changes,
  issues,
  blocked,
  saving,
  onSave,
  onClose,
}: {
  changes: RecordChange[];
  issues: (CellIssue & { name: string })[];
  /** The records that wait: in conflict, or with a cell to fix. */
  blocked: ReadonlySet<string>;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const ready = changes.filter((c) => !blocked.has(c.key)).length;
  return (
    <FloatingCard role="region" aria-label="Review the change" className={cn(FLOAT, "z-20 gap-3 overflow-auto py-4")}>
      <CardHeader className="flex items-center gap-2 px-4">
        <CardHeading>Review: {plural(changes.length, "record")}</CardHeading>
        <span className="text-xs text-muted-foreground">saved as one run, recorded as you</span>
        <TipButton tip="Close" size="icon-sm" className="ml-auto" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </TipButton>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 text-sm">
        {issues.length > 0 && (
          <ul
            aria-label="To fix first"
            className="flex flex-col gap-1 rounded-md bg-tone-bad p-2 text-tone-bad-foreground"
          >
            {issues.map((issue) => (
              <li key={`${issue.key}\u0000${issue.field}`}>
                <span className="font-medium">{issue.name || "New record"}</span> · <code>{issue.field}</code>:{" "}
                {issue.error}
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {changes.slice(0, LISTED).map((change) => (
            <div key={change.key} className="contents">
              <dt className="truncate text-muted-foreground">{change.name || "New record"}</dt>
              <dd className="flex flex-col gap-1">
                {change.type === "delete" ? (
                  <span>
                    <ToneBadge tone={GRID_CHANGE_TONE.removed}>deleted</ToneBadge>
                  </span>
                ) : change.type === "insert" ? (
                  <span>
                    <ToneBadge tone={GRID_CHANGE_TONE.added}>new record</ToneBadge>
                  </span>
                ) : (
                  change.fields.map(({ field, before, after }) => (
                    <span key={field} className="flex flex-wrap items-center gap-1.5">
                      <code className="text-xs text-muted-foreground">{field}</code>
                      <span className="text-muted-foreground line-through">{cellText(before) || "none"}</span>
                      <span aria-hidden>→</span>
                      <span className="sr-only">to</span>
                      <ToneBadge tone={GRID_CHANGE_TONE.changed}>{cellText(after) || "none"}</ToneBadge>
                    </span>
                  ))
                )}
              </dd>
            </div>
          ))}
        </dl>
        {changes.length > LISTED && (
          <p className="text-muted-foreground">and {plural(changes.length - LISTED, "more record")}</p>
        )}
        <div className="flex items-center gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            {plural(ready, "record")}
            {blocked.size > 0 && ` · ${blocked.size} wait for what to settle or fix first`}
          </span>
          <Button size="sm" className="ml-auto" disabled={saving || ready === 0} onClick={onSave}>
            {saving ? "Saving…" : `Save ${ready} now`}
          </Button>
        </div>
      </CardContent>
    </FloatingCard>
  );
}

/** The footer's note while a change is staged: not saved, and what the last step did, which Cmd/Ctrl+Z takes back. */
export function StagedNote({ staged, changes }: { staged: Staged; changes: number }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <>
      <span aria-hidden>·</span>
      <span className="flex items-center gap-1.5">
        Not saved: {plural(changes, "change")} <StatusDot tone="waiting" className="size-1.5" />
      </span>
      <span aria-hidden>·</span>
      <span>
        {staged.steps.at(-1)?.said} · <kbd className="font-mono">{mac ? "Cmd" : "Ctrl"} Z</kbd> undoes it
      </span>
    </>
  );
}

/**
 * The change staged over `view`'s records, as the grid shows it and saves it: each record's
 * change, the cells to fix, the conflicts a Save found, what the last Save said, and `stage`,
 * `save` and `settle`. `listed` is the rows shown: a record read or saved since may hold a new
 * one's key. `onSaved` is told when a Save saved. `reading` says another search's records are
 * being read: the rows shown are the last search's, whose change that search would lose.
 */
export function useStagedChange({
  view: { collection: records, stage },
  keyField,
  required,
  listed,
  reading,
  onSaved,
}: {
  view: RecordsView;
  keyField: string;
  /** The fields a new record needs. */
  required: readonly string[];
  listed: readonly Saved[];
  reading: boolean;
  onSaved: () => void;
}) {
  const staged = useSyncExternalStore(stage.subscribe, stage.current, stage.current);
  const saving = staged?.saving === true;
  const changes = useMemo(() => changesOf(staged, keyField), [staged, keyField]);
  const counts = useMemo(() => countsOf(changes), [changes]);
  const changeOfKey = useMemo(() => new Map(changes.map((change) => [change.key, change])), [changes]);
  const changedCells = useMemo(
    () => new Set(changes.flatMap(({ key, fields }) => fields.map(({ field }) => conflictId({ key, field })))),
    [changes],
  );
  const issues = useMemo(
    () => issuesOf(staged, keyField, required, (key) => records.has(key)),
    [staged, keyField, required, records, listed],
  );
  const issueAt = useMemo(() => new Map(issues.map((issue) => [conflictId(issue), issue])), [issues]);
  // The conflicts a Save found, while their record is still in the change: one whose record
  // leaves it (discarded, undone, saved, denied) is let go, never shown again over a later change.
  const [found, setFound] = useState<ReadonlyMap<string, Conflict>>(new Map());
  const conflicts = [...found.values()].filter((c) => changeOfKey.has(c.key));
  if (conflicts.length !== found.size) setFound(new Map(conflicts.map((c) => [conflictId(c), c])));
  const blocked = new Set([...issues, ...conflicts].map((c) => c.key));
  const [reviewing, setReviewing] = useState(false);
  // Nothing staged, nothing to review: the next change opens without the card.
  if (reviewing && !staged) setReviewing(false);
  // A change held for an approval: how many records, and its run of `call`.
  const [held, setHeld] = useState<{ held: number; runId: string | undefined }>();
  // The records the policy refused in the last Save, dropped from the change.
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set());
  /** Whether a Save is under way, said: the change being saved takes nothing else until it answers. */
  const busy = () => saving && (toast.info("Saving the change: try again once it is saved"), true);

  return {
    staged,
    saving,
    changes,
    counts,
    changeOfKey,
    changedCells,
    issues,
    issueAt,
    conflicts,
    blocked,
    reviewing,
    setReviewing,
    held,
    closeHeld: () => setHeld(undefined),
    denied,
    /** Stages `step`, answering whether it did: what the last Save said gives way to it, not to a step refused. */
    add(step: Step): boolean {
      if (reading) return (toast.info("Reading the records: try again once they show"), false);
      try {
        if (busy() || !stage.add(step)) return false;
      } catch (err) {
        return (toast.error(errorMessage(err)), false);
      }
      setHeld(undefined);
      setDenied(new Set());
      return true;
    },
    /** Saves the change, or the records `only` names, as one `saveMany`, and says what came of it. */
    async save(only?: ReadonlySet<string>) {
      // A Save under way answers for itself: the stage would answer this one as nothing saved.
      if (busy()) return;
      try {
        const outcome = await stage.save(only);
        if ("conflicts" in outcome) {
          // Each changed field of each record found changed since is a conflict to settle, a delete's on its key.
          const now = new Map(changesOf(stage.current(), keyField).map((change) => [change.key, change]));
          setFound((all) => {
            const next = new Map(all);
            for (const { key, current } of outcome.conflicts) {
              const change = now.get(key);
              const cells = change?.fields.length ? change.fields : [{ field: keyField, after: undefined }];
              for (const { field, after } of cells) {
                const conflict = { key, field, mine: after, current, staged: true as const };
                next.set(conflictId(conflict), conflict);
              }
            }
            return next;
          });
          if (outcome.conflicts.length)
            toast.warning(`${plural(outcome.conflicts.length, "record")} changed since you staged them`, {
              description: "Nothing was saved: settle each one, then save again.",
            });
          else
            toast.warning("A record has a new record's key already", {
              description: "Nothing was saved: change its key, then save again.",
            });
        } else if ("denied" in outcome) {
          setDenied(new Set(outcome.denied));
          toast.error(
            outcome.denied.length ? `Could not save ${outcome.denied.join(", ")}` : "Could not save the change",
            { description: errorMessage(outcome.error) },
          );
        } else if ("held" in outcome) {
          setReviewing(false);
          setHeld(outcome);
        } else {
          setReviewing(false);
          onSaved();
          toast.success(`Saved ${plural(outcome.saved, "record")}`);
        }
      } catch (err) {
        toast.error("Could not save: nothing changed", { description: errorMessage(err) });
      }
    },
    /** A conflict a Save found, settled: Keep theirs drops your change to the cell; the last settled, the change is saved over theirs. */
    settle(conflict: Conflict, keep: "theirs" | "mine") {
      // Settling makes the change again: never under a Save of the rest, whose transaction it would roll back.
      if (busy()) return;
      setFound((all) => {
        const next = new Map(all);
        next.delete(conflictId(conflict));
        return next;
      });
      if (keep === "theirs")
        stage.drop(conflict.key, changeOfKey.get(conflict.key)?.type === "delete" ? undefined : conflict.field);
      const others = conflicts.some((c) => c.key === conflict.key && conflictId(c) !== conflictId(conflict));
      if (!others) stage.rebase(conflict.key, conflict.current ?? null);
    },
  };
}
