import type { ErrorInfo, LedgerRecord } from "@sanoma-ai/workflows";
import type { ConfigDescription, OpEntry } from "@sanoma-ai/workflows/describe";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CrosshairIcon } from "@phosphor-icons/react/dist/csr/Crosshair";
import { memo, type ReactNode } from "react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "#/components/ui/item.tsx";
import { utcText } from "#/lib/time.ts";
import type { RunCheck } from "../api.ts";
import { configQuery, opsById } from "../queries.ts";
import {
  ALONE,
  DecisionBadge,
  DecisionNote,
  Expandable,
  ItemTime,
  ledgerTone,
  OpName,
  plural,
  RequestedBy,
  StatusDot,
  TipButton,
  UtcTime,
  When,
} from "./common.tsx";

// A run's ledger and checks, one row each, as the run page lists them, the jump from a graph node
// to its row, and the ledger as a short trace, as a run's floating card shows it.

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

/**
 * One ledger record: what happened, when, and its details. Drawn again only when they change.
 * `onShow`, when given, is a "Show in graph" button, called with the record's id. The ledger's
 * own rows are `anchor`s, the ones `show` scrolls to; a copy elsewhere on the page (the
 * inspector's) is not, so the page has one element of each id.
 */
export const LedgerRow = memo(function LedgerRow({
  record,
  titles,
  onShow,
  anchor = true,
}: {
  record: LedgerRecord;
  titles: Map<string, string>;
  onShow?: ((recordId: string) => void) | undefined;
  anchor?: boolean;
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
          <p>
            Started by {record.actor.id}
            {record.scheduledFor && (
              <>
                , on its schedule for <UtcTime at={record.scheduledFor} />
              </>
            )}
          </p>
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
              {`${record.durationMs} ms${record.attempt && record.attempt > 1 ? `, attempt ${record.attempt}` : ""}`}
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
          <RequestedBy requestedBy={record.requestedBy} op={record.op} reasons={record.reasons} />
        </p>
      );
      break;
    case "approval.decided":
      kind = record.decision === "approve" ? "approved" : "rejected";
      body = (
        <p>
          {record.by} {record.decision === "approve" ? "approved" : "rejected"} “{title(record.approval)}”
          {record.alone ? ALONE : null}
          {record.note ? <DecisionNote note={record.note} /> : null}
        </p>
      );
      break;
    case "approval.withdrawn":
      kind = "withdrawn";
      body = <p>{traceLine(record, title)}</p>;
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
            Seeded {record.seeds.length} from scenario “{record.scenario}”
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
          Until <UtcTime at={record.until} />
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
      id={anchor ? ledgerItemId(record.id) : undefined}
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
      <ItemTime at={record.at} />
      {onShow && (
        <ItemActions className="self-start">
          <TipButton tip="Show in graph" size="icon-xs" onClick={() => onShow(record.id)}>
            <CrosshairIcon aria-hidden="true" />
          </TipButton>
        </ItemActions>
      )}
    </Item>
  );
});

/** What a ledger record says in a line of the trace. */
function traceLine(record: LedgerRecord, title: (approval: string) => string): ReactNode {
  switch (record.type) {
    case "run.started":
      return `Started by ${record.actor.id}`;
    case "op.called":
      return (
        <>
          {record.name && record.name !== record.op && <>{record.name} </>}
          <code className="text-xs text-muted-foreground">{record.op}</code>
          {record.error && <span className="text-destructive"> failed</span>}
        </>
      );
    case "approval.requested":
      return `Asked ${approverLabel(record.approver)}: “${record.title}”`;
    case "approval.decided":
      return `${record.by} ${record.decision === "approve" ? "approved" : "rejected"} “${title(record.approval)}”`;
    case "approval.withdrawn":
      return `${record.by ?? "The run"} withdrew “${title(record.approval)}”: ${record.reason}`;
    case "approval.refused":
      return `Ignored a message on “${title(record.approval)}”`;
    case "scenario.seeded":
      return `Seeded from scenario “${record.scenario}”`;
    case "sleep.started":
      return `${record.name ?? "Sleep"} until ${utcText(record.until)}`;
    case "run.finished":
      return "Finished";
    case "run.failed":
      return <span className="text-destructive">Failed: {record.error.message}</span>;
  }
}

/** A run's ledger as a short trace, a line a record: its dot, what happened, and when. */
export function LedgerTrace({ ledger, titles }: { ledger: LedgerRecord[]; titles: Map<string, string> }) {
  const title = (approval: string) => titles.get(approval) ?? approval;
  return (
    <ol aria-label="Ledger" className="flex flex-col gap-1.5">
      {ledger.map((record) => (
        <li key={record.id} className="flex items-start gap-2">
          <StatusDot tone={ledgerTone(record)} className="mt-1.5" />
          <span className="min-w-0 flex-1 wrap-anywhere">{traceLine(record, title)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <When at={record.at} />
          </span>
        </li>
      ))}
    </ol>
  );
}
