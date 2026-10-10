import type { ErrorInfo, LedgerRecord } from "@sanoma/workflows";
import type { ConfigDescription, OpEntry } from "@sanoma/workflows/describe";
import { approverLabel } from "@sanoma/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { memo, type ReactNode } from "react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "#/components/ui/item.tsx";
import { utcText } from "#/lib/time.ts";
import type { RunCheck } from "../api.ts";
import { configQuery, opsById } from "../queries.ts";
import {
  DecisionBadge,
  DecisionNote,
  Expandable,
  ledgerTone,
  OpName,
  plural,
  RequestedBy,
  StatusDot,
  When,
} from "./common.tsx";

// A run's ledger and checks, one row each, as the run page lists them, and the jump from a graph
// node to its row.

/** How long a ledger item stays highlighted after a click on its node in the graph. */
const HIGHLIGHT_MS = 2_000;

/** The ledger item a click on the graph lit last, until its timer puts it out. */
let lit: { item: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Scrolls to a record's ledger item and highlights it for a while: an attribute on the element,
 * so the page does not render for it.
 */
export function show(recordId: string, reducedMotion: boolean) {
  const item = document.getElementById(ledgerItemId(recordId));
  if (!item) return;
  item.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  if (lit) {
    clearTimeout(lit.timer);
    delete lit.item.dataset.highlighted;
  }
  item.dataset.highlighted = "";
  const timer = setTimeout(() => {
    delete item.dataset.highlighted;
    lit = undefined;
  }, HIGHLIGHT_MS);
  lit = { item, timer };
}

/**
 * One of a sandbox run's checks, as a ledger row is drawn: met, failed with why, or "not yet"
 * while its answer can still change.
 */
export function CheckRow({ check }: { check: RunCheck }) {
  const tone = !check.settled ? "waiting" : check.ok ? "ok" : "bad";
  const detail = check.settled ? check.detail : "not yet";
  return (
    <Item role="listitem" variant="outline" size="sm">
      <ItemContent className="min-w-0">
        <ItemTitle>
          <StatusDot tone={tone} />
          {check.step}
        </ItemTitle>
        {detail && <ItemDescription>{detail}</ItemDescription>}
      </ItemContent>
    </Item>
  );
}

/** An error from the ledger, with what the vendor said when the driver kept it, and `then`: what came of it. */
function ErrorText({ error, then }: { error: ErrorInfo; then?: string | undefined }) {
  const vendor = [error.status === undefined ? "" : `status ${error.status}`, error.vendorCode ?? ""]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <p className="text-destructive">
        {error.message}
        {vendor && <span className="text-muted-foreground"> ({vendor})</span>}
      </p>
      {then && <p className="text-muted-foreground">{then}</p>}
    </>
  );
}

/** Whether a failed call was tried again, from its attempt and the config's entry for its operation. */
function retries(attempt: number, op: OpEntry | undefined, vendors: ConfigDescription["vendors"]) {
  if (attempt > 1 || op?.idempotent) return `Tried ${plural(attempt, "time")}`;
  if (!op) return undefined;
  const vendor = vendors[op.vendor]?.title ?? op.vendor;
  return `Not retried: this operation is not safe to repeat. Check ${vendor} before starting again.`;
}

/** A ledger record's item on the page, by the record's id: where a click on the graph leads. */
const ledgerItemId = (recordId: string) => `ledger-${recordId}`;

/** One ledger record: what happened, when, and its details. Drawn again only when they change. */
export const LedgerRow = memo(function LedgerRow({
  record,
  titles,
}: {
  record: LedgerRecord;
  titles: Map<string, string>;
}) {
  const title = (approval: string) => titles.get(approval) ?? approval;
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select: (config) => config.vendors });
  let kind = "";
  let body: ReactNode;
  switch (record.type) {
    case "run.started":
      kind = "started";
      body = (
        <>
          <p>Started by {record.actor.id}</p>
          <Expandable label="Input" value={record.input} />
        </>
      );
      break;
    case "op.called":
      kind = "called";
      body = (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <OpName id={record.op} op={ops.get(record.op)} effect={record.effect} />
            <DecisionBadge decision={record.decision} />
            <span className="text-muted-foreground">
              {record.durationMs} ms{record.attempt && record.attempt > 1 ? `, attempt ${record.attempt}` : ""}
            </span>
          </p>
          {record.error && (
            <ErrorText error={record.error} then={retries(record.attempt ?? 1, ops.get(record.op), vendors)} />
          )}
          <Expandable label="Input" value={record.input} />
          {"output" in record && <Expandable label="Output" value={record.output} />}
        </>
      );
      break;
    case "approval.requested":
      kind = "asked";
      body = (
        <p>
          “{record.title}” asked of {approverLabel(record.approver)} by{" "}
          <RequestedBy requestedBy={record.requestedBy} op={record.op} />
        </p>
      );
      break;
    case "approval.decided":
      kind = record.decision === "approve" ? "approved" : "rejected";
      body = (
        <p>
          {record.by} {record.decision === "approve" ? "approved" : "rejected"} “{title(record.approval)}”
          {record.note ? <DecisionNote note={record.note} /> : null}
        </p>
      );
      break;
    case "approval.refused":
      kind = "ignored";
      body = (
        <p>
          Ignored a message from {record.by ?? "someone"} on “{title(record.approval)}”: {record.reason}
        </p>
      );
      break;
    case "scenario.seeded":
      kind = "seeded";
      body = (
        <>
          <p>
            Seeded {plural(record.seeds.length, "call")} from scenario “{record.scenario}”
          </p>
          {record.seeds.length > 0 && <Expandable label="Seeds" value={record.seeds} />}
        </>
      );
      break;
    case "sleep.started":
      // A time to come, which a relative time ("just now") would not say: in UTC.
      kind = "sleeping";
      body = (
        <p>
          Until <time dateTime={new Date(record.until).toISOString()}>{utcText(record.until)}</time>
        </p>
      );
      break;
    case "run.finished":
      kind = "finished";
      body = <Expandable label="Output" value={record.output} />;
      break;
    case "run.failed":
      kind = "failed";
      body = <ErrorText error={record.error} />;
      break;
  }
  return (
    <Item
      role="listitem"
      variant="outline"
      size="sm"
      id={ledgerItemId(record.id)}
      // `show` sets data-highlighted.
      className="scroll-mt-24 data-highlighted:bg-muted data-highlighted:ring-2 data-highlighted:ring-ring"
    >
      <ItemContent className="min-w-0">
        <ItemTitle>
          <StatusDot tone={ledgerTone(record)} />
          {kind}
        </ItemTitle>
        <div className="flex flex-col gap-1">{body}</div>
      </ItemContent>
      <ItemActions className="self-start text-xs text-muted-foreground">
        <When at={record.at} />
      </ItemActions>
    </Item>
  );
});
