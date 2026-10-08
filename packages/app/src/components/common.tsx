import type { ApprovalState, Effect, RecordedDecision, RunStatus } from "@sanoma/workflows";
import { ChevronRightIcon, CircleAlertIcon, InfoIcon } from "lucide-react";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { approverName } from "../api.ts";

// Small pieces shared by the screens, composed from the shadcn components in ./ui.

/** One colour per effect, the same everywhere: Badge has a variant for each. */
export function EffectBadge({ effect }: { effect: Effect }) {
  return <Badge variant={effect}>{effect}</Badge>;
}

/** Badge has a variant for each run status. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge variant={status}>{status}</Badge>;
}

const APPROVAL_VARIANT = { pending: "waiting", approved: "finished", rejected: "failed" } as const;

export function ApprovalStatusBadge({ status }: { status: ApprovalState["status"] }) {
  return <Badge variant={APPROVAL_VARIANT[status]}>{status}</Badge>;
}

const DECISION_VARIANT = { allow: "finished", deny: "failed", approve: "waiting" } as const;

/** The policy's decision on an operation call. */
export function DecisionBadge({ decision }: { decision: RecordedDecision }) {
  const approver = decision.kind === "approve" ? approverName(decision.approver) : undefined;
  const title =
    decision.kind === "deny" ? decision.reason : approver ? `held for ${approver}` : "allowed by the policy";
  return (
    <Badge variant={DECISION_VARIANT[decision.kind]} title={title}>
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

/** JSON behind a disclosure, for inputs and outputs that are usually too long to show inline. Written out only once opened. */
export function Expandable({ label, value }: { label: string; value: unknown }) {
  return (
    <Collapsible className="group/expand">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground">
          <ChevronRightIcon
            data-icon="inline-start"
            className="transition-transform group-data-open/expand:rotate-90"
          />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Json value={value} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A callout: a fact about the page, or (`bad`) something that went wrong. */
export function Notice({ tone = "muted", children }: { tone?: "muted" | "bad"; children: ReactNode }) {
  return (
    <Alert variant={tone === "bad" ? "destructive" : "default"}>
      {tone === "bad" ? <CircleAlertIcon /> : <InfoIcon />}
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
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/** Label and value pairs. */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm [&_dd]:break-words [&_dt]:text-muted-foreground">
      {children}
    </dl>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
