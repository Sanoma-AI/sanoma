import type { ApprovalState, Builtin, Effect, LedgerRecord, RecordedDecision } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMatches } from "@tanstack/react-router";
import { cva } from "class-variance-authority";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  InfoIcon,
  type LucideIcon,
  SplitIcon,
  UserCheckIcon,
} from "lucide-react";
import {
  type ComponentProps,
  lazy,
  type ReactElement,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Card } from "#/components/ui/card.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "#/components/ui/item.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { utcText } from "#/lib/time.ts";
import { cn } from "#/lib/utils.ts";
import { APPROVAL_TONE, DECISION_TONE, type Tone } from "#/lib/tone.ts";
import type { OpEntry } from "@sanoma/workflows/describe";
import { approverLabel } from "@sanoma/workflows/shared";
import { configQuery } from "../queries.ts";
import type { CodeProps } from "./code.tsx";
import type { GraphProps } from "./graph.tsx";

// Small pieces shared by the screens, composed from the shadcn components in ./ui.

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page's name: its breadcrumb, its <h1> (PageHeader) and its <title> (pageTitle). */
    crumb?: string;
  }
}

/**
 * The names of the pages the location matches, outermost first, each with where it is. A route
 * names its page in `staticData.crumb`, or, when the name is something it loaded, in its loader
 * data's `crumb`; a route that names nothing (the root, an index) is left out.
 */
export const useCrumbs = () =>
  useMatches({
    select: (matches) =>
      matches.flatMap(({ id, pathname, staticData, loaderData }) => {
        const label = (loaderData && "crumb" in loaderData ? loaderData.crumb : undefined) ?? staticData.crumb;
        return label ? [{ id, pathname, label }] : [];
      }),
    structuralSharing: true,
  });

/** A page's <title>, from its crumb: `head: ({ match }) => pageTitle(match.staticData.crumb)`. */
export const pageTitle = (crumb: string | undefined) => ({
  meta: [{ title: crumb ? `${crumb} · Sanoma` : "Sanoma" }],
});

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

/** Badge colours by tone, over Badge's default variant. */
const toneBadge = cva("", {
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

/** A badge in a tone's colours: what a status means, the same everywhere (the --tone-* tokens). */
export function ToneBadge({
  tone,
  ...props
}: Omit<ComponentProps<typeof Badge>, "className" | "variant"> & { tone: Tone }) {
  return <Badge {...props} className={toneBadge({ tone })} />;
}

/** Marks a sandbox run: one seeded from the scenario named, calling fakes, not the vendors. */
export function SandboxBadge({ name }: { name: string }) {
  return <ToneBadge tone="idle">sandbox · {name}</ToneBadge>;
}

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

/**
 * A vendor's logo, 16 px unless `className` sizes it, named by the vendor's title for assistive
 * tech unless `alt` says otherwise (`""` where the title is beside it): its connector's light
 * variant, and its dark one under the dark theme. Nothing when the connector gives no logo.
 */
export function VendorLogo({ vendor, alt, className }: { vendor: string; alt?: string; className?: string }) {
  const { data: entry } = useSuspenseQuery({ ...configQuery(), select: (config) => config.vendors[vendor] });
  if (!entry?.logo) return null;
  const { src, dark } = entry.logo;
  const name = alt ?? entry.title;
  // A hidden <img> is out of the accessibility tree: one name is read either way.
  return (
    <>
      <img src={src} alt={name} className={cn("size-4 shrink-0", dark && "dark:hidden", className)} />
      {dark && <img src={dark} alt={name} className={cn("hidden size-4 shrink-0 dark:block", className)} />}
    </>
  );
}

/**
 * An operation by id, after its vendor's logo, with its effect's badge when the effect is known.
 * `op` is the config's entry for it (`opsById`): no logo when the config does not know it.
 */
export function OpName({
  id,
  op,
  effect = op?.effect,
}: {
  id: string;
  op: OpEntry | undefined;
  effect?: Effect | undefined;
}) {
  return (
    <>
      {op && <VendorLogo vendor={op.vendor} />}
      <code>{id}</code>
      {effect && <Badge className={effectBadge({ effect })}>{effect}</Badge>}
    </>
  );
}

/**
 * An operation as a list item: its name, whether it is safe to retry, and what it does, then
 * `children`, when given, under that. Inside an `ItemGroup`.
 */
export function OpItem({ id, op, children }: { id: string; op: OpEntry | undefined; children?: ReactNode }) {
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemTitle>
          <OpName id={id} op={op} />
          {op?.idempotent && (
            <Tip tip="If a call fails, it is tried again; the vendor ignores repeats.">
              <Badge variant="outline" tabIndex={0}>
                safe to retry
              </Badge>
            </Tip>
          )}
        </ItemTitle>
        {op?.description && <ItemDescription>{op.description}</ItemDescription>}
        {children}
      </ItemContent>
    </Item>
  );
}

/**
 * Each built-in as a thing, where an operation shows its vendor's logo: an approval, a person who
 * decides; a sleep, a clock; `ctx.all`, calls that run in parallel.
 */
export const BUILTIN_ICON = {
  approval: UserCheckIcon,
  sleep: ClockIcon,
  all: SplitIcon,
} satisfies Record<Builtin, LucideIcon>;

/** A tone as a dot, where a badge would be too much. */
export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={dot({ tone })} />;
}

export function ApprovalStatusBadge({ status }: { status: ApprovalState["status"] }) {
  return <ToneBadge tone={APPROVAL_TONE[status]}>{status}</ToneBadge>;
}

/**
 * A tooltip on a control. Only on what takes focus (a button, a link, or a badge given
 * `tabIndex={0}` because its tooltip says something it does not), so a keyboard reaches it too.
 * Passive detail on many items, such as a time's exact value, is a native `title` instead.
 */
export function Tip({ tip, children }: { tip: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** The policy's decision on an operation call; a denial's reason is its tooltip. */
export function DecisionBadge({ decision }: { decision: RecordedDecision }) {
  const tone = DECISION_TONE[decision.kind];
  if (decision.kind === "deny") {
    return (
      <Tip tip={decision.reason}>
        <ToneBadge tone={tone} tabIndex={0}>
          deny
        </ToneBadge>
      </Tip>
    );
  }
  return (
    <ToneBadge tone={tone}>
      {decision.kind}
      {decision.kind === "approve" ? ` · ${approverLabel(decision.approver)}` : ""}
    </ToneBadge>
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
/** The server, and the browser while it hydrates, know no time: they render the UTC time. */
const noClock = () => undefined;

/**
 * A time, relative to now in the browser, with the UTC time as its title. The server renders
 * the UTC time, so the page hydrates the same markup whatever the browser's clock and time zone.
 */
export function When({ at }: { at: number }) {
  const clock = useSyncExternalStore(watchClock, readClock, noClock);
  const utc = utcText(at, { seconds: true });
  return (
    <time dateTime={new Date(at).toISOString()} title={utc}>
      {clock === undefined ? utc : ago(at, clock)}
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

/**
 * The graph's chunk: React Flow and dagre, which lay out and draw the graph the page builds. It
 * needs the DOM, so it loads in the browser only, as one chunk for every page that draws a graph.
 * A page's loader calls this in the browser, so the chunk loads while the page hydrates rather
 * than after.
 */
export const loadGraph = () => import("./graph.tsx");
const Graph = lazy(loadGraph);

/** True once the element has come within a screen of the viewport, and from then on. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * A box 220 px high, 280 px from `sm` (or as `className` says), whose content loads and draws in
 * the browser once the box comes near the screen; until then, and on the server, `fallback`
 * holds its place. (The server never sees the box: `useSeen` flips in an effect, and effects run
 * only in the browser.)
 */
function LazyPanel({
  fallback,
  className,
  children,
}: {
  fallback: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  return (
    <Card ref={box} className={cn("h-[220px] gap-0 py-0 sm:h-[280px]", className)}>
      {seen ? <Suspense fallback={fallback}>{children}</Suspense> : fallback}
    </Card>
  );
}

/** A graph (a run's, or a workflow's outline) in a LazyPanel, a skeleton of its size holding its place. */
export const GraphPanel = ({ className, ...props }: GraphProps & { className?: string }) => (
  <LazyPanel
    className={className}
    fallback={<Skeleton role="status" aria-label="Loading the graph" className="size-full rounded-none" />}
  >
    <Graph {...props} />
  </LazyPanel>
);

/**
 * The source view's chunk: CodeMirror and its TypeScript grammar. Like the graph's, it needs the
 * DOM and loads in the browser only; a page's loader calls this in the browser to warm it.
 */
export const loadCode = () => import("./code.tsx");
const Code = lazy(loadCode);

/**
 * A workflow's source in a LazyPanel, scrolling inside it. On the server, without JavaScript, and
 * until the view loads, the panel holds the source as plain text.
 */
export const CodePanel = ({ className, ...props }: CodeProps) => (
  <LazyPanel
    className={className}
    fallback={<pre className="size-full overflow-auto p-3 font-mono text-xs">{props.source}</pre>}
  >
    <Code {...props} />
  </LazyPanel>
);

/**
 * A page's heading row: its <h1>, which is its crumb, after `icon` when given, whatever sits
 * beside it, and the page's `action` at the far end.
 */
export function PageHeader({ icon, children, action }: { icon?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const title = useCrumbs().at(-1)?.label;
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight">
        {icon}
        {title}
      </h1>
      {children}
      {action && <div className="ml-auto">{action}</div>}
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

/** A card's section: its heading, and what it holds. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </div>
  );
}

/** What a section says when it has nothing to list. */
export function None({ children = "None." }: { children?: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

/** Label and value pairs, as a description list of `Fact`s: labels in one column, values in the other. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere">{children}</dd>
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
