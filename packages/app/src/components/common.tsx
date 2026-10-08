import type { ApprovalState, Effect, LedgerRecord, RecordedDecision, RunStatus } from "@sanoma/workflows";
import { cva } from "class-variance-authority";
import { ChevronRightIcon, CircleAlertIcon, InfoIcon } from "lucide-react";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
import { approverLabel } from "@sanoma/workflows/shared";

// Small pieces shared by the screens, composed from the shadcn components in ./ui.

/** What a status means, one colour each (the --tone-* tokens in style.css). */
export type Tone = "ok" | "bad" | "waiting" | "active" | "idle" | "off";

export const RUN_TONE: Record<RunStatus, Tone> = {
  queued: "idle",
  running: "active",
  waiting: "waiting",
  finished: "ok",
  failed: "bad",
  cancelled: "off",
};

export const APPROVAL_TONE: Record<ApprovalState["status"], Tone> = {
  pending: "waiting",
  approved: "ok",
  rejected: "bad",
};

export const DECISION_TONE: Record<RecordedDecision["kind"], Tone> = { allow: "ok", deny: "bad", approve: "waiting" };

/** A ledger record's tone: what it did to the run. */
export function ledgerTone(record: LedgerRecord): Tone {
  switch (record.type) {
    case "op.called":
      return record.error ? "bad" : "off";
    case "approval.requested":
      return "waiting";
    case "approval.decided":
      return record.decision === "approve" ? "ok" : "bad";
    case "run.finished":
      return "ok";
    case "run.failed":
      return "bad";
    default:
      return "off";
  }
}

/** Badge colours by tone, over Badge's default variant: `<Badge className={toneBadge({ tone })}>`. */
export const toneBadge = cva("", {
  variants: {
    tone: {
      ok: "bg-tone-ok text-tone-ok-foreground",
      bad: "bg-tone-bad text-tone-bad-foreground",
      waiting: "bg-tone-waiting text-tone-waiting-foreground",
      active: "bg-tone-active text-tone-active-foreground",
      idle: "bg-tone-idle text-tone-idle-foreground",
      off: "bg-tone-off text-tone-off-foreground",
    } satisfies Record<Tone, string>,
  },
});

/** Badge colours by operation effect, one each, the same everywhere (the --effect-* tokens). */
export const effectBadge = cva("", {
  variants: {
    effect: {
      read: "bg-effect-read text-effect-read-foreground",
      write: "bg-effect-write text-effect-write-foreground",
      publish: "bg-effect-publish text-effect-publish-foreground",
      send: "bg-effect-send text-effect-send-foreground",
      money: "bg-effect-money text-effect-money-foreground",
      access: "bg-effect-access text-effect-access-foreground",
    } satisfies Record<Effect, string>,
  },
});

const dot = cva("size-2.5 rounded-full", {
  variants: {
    tone: {
      ok: "bg-tone-ok-foreground",
      bad: "bg-tone-bad-foreground",
      waiting: "bg-tone-waiting-foreground",
      active: "bg-tone-active-foreground",
      idle: "bg-tone-idle-foreground",
      off: "bg-muted-foreground/50",
    } satisfies Record<Tone, string>,
  },
});

/** A tone as a dot, where a badge would be too much. */
export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={dot({ tone })} />;
}

export function ApprovalStatusBadge({ status }: { status: ApprovalState["status"] }) {
  return <Badge className={toneBadge({ tone: APPROVAL_TONE[status] })}>{status}</Badge>;
}

/** The policy's decision on an operation call. */
export function DecisionBadge({ decision }: { decision: RecordedDecision }) {
  const approver = decision.kind === "approve" ? approverLabel(decision.approver) : undefined;
  const title =
    decision.kind === "deny" ? decision.reason : approver ? `held for ${approver}` : "allowed by the policy";
  return (
    <Badge className={toneBadge({ tone: DECISION_TONE[decision.kind] })} title={title}>
      {decision.kind}
      {approver ? ` · ${approver}` : ""}
    </Badge>
  );
}

function ago(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
}

// One clock for every `When` on the page, ticking every 15 s while any is shown.
let now: number | undefined;
const watchers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function watchClock(onTick: () => void) {
  watchers.add(onTick);
  if (!ticker) {
    // A clock read while nothing watched it may be old: catch up now.
    now = Date.now();
    ticker = setInterval(() => {
      now = Date.now();
      for (const watcher of watchers) watcher();
    }, 15_000);
  }
  return () => {
    watchers.delete(onTick);
    if (!watchers.size) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

const readClock = () => (now ??= Date.now());
/** The server, and the browser while it hydrates, know no time: they render the ISO time. */
const noClock = () => undefined;

/**
 * A time, relative to now in the browser. The server renders the ISO time, so the page
 * hydrates the same markup whatever the browser's clock and time zone.
 */
export function When({ at }: { at: number }) {
  const clock = useSyncExternalStore(watchClock, readClock, noClock);
  const iso = new Date(at).toISOString();
  return (
    <time dateTime={iso} title={clock === undefined ? iso : new Date(at).toLocaleString()}>
      {clock === undefined ? iso.replace("T", " ").slice(0, 19) : ago(at, clock)}
    </time>
  );
}

export function Json({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "undefined", [value]);
  return (
    <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">
      {text}
    </pre>
  );
}

/** Something behind a small toggle, closed at first. The content renders only once opened. */
export function Disclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Collapsible className="group/disclosure">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground">
          <ChevronRightIcon
            data-icon="inline-start"
            className="transition-transform group-data-open/disclosure:rotate-90"
          />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** JSON behind a disclosure, for inputs and outputs that are usually too long to show inline. */
export function Expandable({ label, value }: { label: string; value: unknown }) {
  return (
    <Disclosure label={label}>
      <Json value={value} />
    </Disclosure>
  );
}

/** A callout: a fact about the page, or (`destructive`) something that went wrong. */
export function Notice({
  variant = "default",
  children,
}: {
  variant?: "default" | "destructive";
  children: ReactNode;
}) {
  return (
    <Alert variant={variant}>
      {variant === "destructive" ? <CircleAlertIcon /> : <InfoIcon />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** An empty state: nothing to show yet, and what would fill it. */
export function Nothing({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** A page's heading row: its <h1> and whatever sits beside it. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </header>
  );
}

/** A section's heading, under the page's. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-heading text-lg font-semibold tracking-tight">{children}</h2>;
}

/** A heading inside a card's section. */
export function SubsectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium">{children}</h3>;
}

/** Label and value pairs. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

/** Who asked for an approval: "the policy, holding <op>" or "the workflow". */
export function RequestedBy({ requestedBy, op }: Pick<ApprovalState, "requestedBy" | "op">) {
  return requestedBy === "policy" ? (
    <>
      the policy, holding <code>{op}</code>
    </>
  ) : (
    "the workflow"
  );
}

/** The note a decider left, quoted on its own line. */
export function DecisionNote({ note }: { note: string }) {
  return <q className="block text-muted-foreground italic">{note}</q>;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
