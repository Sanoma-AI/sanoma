import type { ApprovalState, Builtin, Effect, LedgerRecord, RecordedDecision } from "@sanoma-ai/workflows";
import type { ResourceProblem } from "@sanoma-ai/workflows/describe";
import { problemAt } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatches, useRouter } from "@tanstack/react-router";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { GitForkIcon } from "@phosphor-icons/react/dist/csr/GitFork";
import { UserCheckIcon } from "@phosphor-icons/react/dist/csr/UserCheck";
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
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Card } from "#/components/ui/card.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import { shortId } from "#/lib/apply-plan.ts";
import { siteOf } from "#/lib/locales.ts";
import { hasOneUrl } from "#/site-path.ts";
import { useSites } from "#/lib/sites.ts";
import { utcText } from "#/lib/time.ts";
import { cn } from "#/lib/utils.ts";
import { APPROVAL_TONE, DECISION_TONE, type Tone } from "#/lib/tone.ts";
import type { OpEntry } from "@sanoma-ai/workflows/describe";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { configQuery, type SiteCaller } from "../queries.ts";
import type { CodeProps } from "./code.tsx";
import type { GraphProps } from "./graph.tsx";
import { ButtonLink, effectBadge, Notice, PageHeader, type PageHeaderProps, Region, Tip, ToneBadge } from "./kit.tsx";

// Small pieces shared by the screens, composed from the shadcn components in ./ui: the kit's, which
// `sanoma/ui` exports (./kit.tsx, re-exported so a screen imports both from here), then the app's
// private ones, some of which read the app (its config, its router's crumbs and sites).
export * from "./kit.tsx";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The page's name: its breadcrumb, its <h1> (CrumbHeader) and its <title> (pageTitle). */
    crumb?: string;
    /** The page takes the page column's full width, not the reading width the root caps others at. */
    wide?: true;
  }
}

/**
 * The names of the pages the location matches, outermost first, each with where it is. A route
 * names its page in `staticData.crumb`, or, when the name is something it loaded, in its loader
 * data's `crumb`; a route that names nothing (the root, an index) is left out. A site's page
 * starts with the site's title, linking to the first page it lists.
 */
export const useCrumbs = () => {
  const sites = useSites();
  return useMatches({
    select: (matches) => {
      const crumbs = matches.flatMap(({ id, pathname, staticData, loaderData }) => {
        // A site's loader may answer with anything an `api` call does, a string or a number too,
        // or `any` while `api` is untyped: read as `unknown`, so no loader's type reaches here.
        const data: unknown = loaderData;
        const named = typeof data === "object" && data !== null && "crumb" in data;
        const label = (named ? (data.crumb as string | undefined) : undefined) ?? staticData.crumb;
        return label ? [{ id, pathname, label }] : [];
      });
      const page = matches.at(-1);
      const site = sites.find(({ name }) => name === siteOf(page?.fullPath));
      if (!page || !site) return crumbs;
      const pathname = site.pages[0]?.to ?? page.pathname;
      return [{ id: `site:${site.name}`, pathname, label: site.title }, ...crumbs];
    },
    structuralSharing: true,
  });
};

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

/** Marks a sandbox run: one seeded from the scenario named, calling fakes, not the vendors. */
export function SandboxBadge({ name }: { name: string }) {
  return <ToneBadge tone="idle">sandbox · {name}</ToneBadge>;
}

/**
 * A logo, 16 px unless `className` sizes it: `src`, and `dark` instead under the dark theme. Only
 * ever an `<img>`, where an SVG's scripts and external references never run or load.
 */
export function Logo({
  src,
  dark,
  alt,
  className,
}: {
  src: string;
  dark?: string | undefined;
  alt: string;
  className?: string | undefined;
}) {
  // A hidden <img> is out of the accessibility tree: one name is read either way.
  return (
    <>
      <img src={src} alt={alt} className={cn("size-4 shrink-0", dark && "dark:hidden", className)} />
      {dark && <img src={dark} alt={alt} className={cn("hidden size-4 shrink-0 dark:block", className)} />}
    </>
  );
}

/**
 * A vendor's logo, as `Logo` draws it, named by the vendor's title for assistive tech unless
 * `alt` says otherwise (`""` where the title is beside it). `fallback` draws in its place when the
 * config has no logo for the vendor.
 */
export function VendorLogo({
  vendor,
  alt,
  className,
  fallback = null,
}: {
  vendor: string;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const { data: entry } = useSuspenseQuery({ ...configQuery(), select: (config) => config.vendors[vendor] });
  if (!entry?.logo) return fallback;
  return <Logo {...entry.logo} alt={alt ?? entry.title} className={className} />;
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
 * An item's title that wraps rather than clips, for a title with badges: a narrow column (About's,
 * on a workflow's page) may be narrower than they are. (`flex` again: given a `line-clamp-*`,
 * `cn` drops ItemTitle's `flex`, which shares its `display`.)
 */
export function ItemHeading({ children }: { children: ReactNode }) {
  return <ItemTitle className="line-clamp-none flex flex-wrap">{children}</ItemTitle>;
}

/**
 * An operation as a list item: its name, whether it is safe to retry, and what it does, then
 * `children`, when given, under that. Inside an `ItemGroup`.
 */
export function OpItem({ id, op, children }: { id: string; op: OpEntry | undefined; children?: ReactNode }) {
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemHeading>
          <OpName id={id} op={op} />
          {op?.idempotent && (
            <Tip tip="If a call fails, it is tried again; the vendor ignores repeats.">
              <Badge variant="outline" tabIndex={0}>
                safe to retry
              </Badge>
            </Tip>
          )}
        </ItemHeading>
        {op?.description && <ItemDescription>{op.description}</ItemDescription>}
        {children}
      </ItemContent>
    </Item>
  );
}

/**
 * A link as a list item, inside an `ItemGroup`: `children` is the link (a `<Link>` or an `<a>`),
 * drawn as an Item with `props`, and marked (`CURRENT_LINK`) while it is the page open. A link to
 * another page ends with `<ItemActions><CaretRightIcon aria-hidden="true" /></ItemActions>` inside the link.
 * shadcn's docs put `role="listitem"` on the Item, but on the link it renders that role would
 * replace the link's: a listitem holds the link instead, so it stays a link. Its content and title may
 * shrink (min-w-0, max-w-full), so a long title in a narrow list is cut where a caller's `truncate`
 * span says, rather than widening the list; its focus ring is drawn inside, where a scrolling list
 * does not clip it.
 */
const LINK_ITEM = "focus-visible:ring-inset [&_[data-slot=item-content]]:min-w-0 [&_[data-slot=item-title]]:max-w-full";

export function LinkItem({
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Item>, "render" | "children"> & { children: ReactElement }) {
  return (
    <div role="listitem">
      <Item render={children} className={cn(CURRENT_LINK, LINK_ITEM, className)} {...props} />
    </div>
  );
}

/** A link while its URL shows: `aria-current="page"`, which Link sets on an active link (or a list sets on the open one). */
const CURRENT_LINK = "aria-[current=page]:bg-muted";

/**
 * Each built-in as a thing, where an operation shows its vendor's logo: an approval, a person who
 * decides; a sleep, a clock; `ctx.all`, calls that run in parallel.
 */
export const BUILTIN_ICON = {
  approval: UserCheckIcon,
  sleep: ClockIcon,
  all: GitForkIcon,
} satisfies Record<Builtin, PhosphorIcon>;

export function ApprovalStatusBadge({ status }: { status: ApprovalState["status"] }) {
  return <ToneBadge tone={APPROVAL_TONE[status]}>{status}</ToneBadge>;
}

/**
 * The policy's decision on an operation call. A denial's tooltip is its reason, a hold's its
 * title, each with the rules behind it (`reasons`, the policies' ids).
 */
export function DecisionBadge({ decision }: { decision: RecordedDecision }) {
  const tone = DECISION_TONE[decision.kind];
  const label = decision.kind === "approve" ? `approve · ${approverLabel(decision.approver)}` : decision.kind;
  const said = decision.kind === "deny" ? decision.reason : decision.kind === "approve" ? decision.title : undefined;
  const rules = decision.kind !== "allow" && decision.reasons?.length ? `By ${decision.reasons.join(", ")}` : undefined;
  const tip = [said, rules].filter(Boolean).join(". ");
  const badge = (
    <ToneBadge tone={tone} tabIndex={tip ? 0 : undefined}>
      {label}
    </ToneBadge>
  );
  return tip ? <Tip tip={tip}>{badge}</Tip> : badge;
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

/** An item's time, at the end of its row, level with its title. */
export function ItemTime({ at }: { at: number }) {
  return (
    <ItemContent className="self-start">
      <ItemDescription className="text-xs">
        <When at={at} />
      </ItemDescription>
    </ItemContent>
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
      <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground" />}>
        <CaretRightIcon
          aria-hidden="true"
          data-icon="inline-start"
          className="transition-transform group-data-open/disclosure:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A page's views, as its pill tabs (shadcn's `Tabs`), each a `LinkTab`: `value` names the one
 * showing. Each view is a URL (`?show=`, `?filter=`, …), so the tabs are links the server renders
 * as the URL says, and a view opens in a new tab or is shared; arrow keys move between them as
 * between tabs. Scrolled sideways rather than widening the page, on a phone.
 */
export function LinkTabs({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <Tabs value={value} className="min-w-0">
      <TabsList aria-label={label} className="max-w-full justify-start overflow-x-auto">
        {children}
      </TabsList>
    </Tabs>
  );
}

/**
 * A view in `LinkTabs`: its `link` (a `<Link>` with no children), labelled `children`, and how
 * many it lists (`count`) in muted figures after the label.
 */
export function LinkTab({
  value,
  link,
  count,
  children,
}: {
  value: string;
  link: ReactElement;
  count?: number | undefined;
  children: ReactNode;
}) {
  return (
    <TabsTrigger value={value} nativeButton={false} render={link} className="flex-none px-2.5">
      {children}
      {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </TabsTrigger>
  );
}

/**
 * A `FloatingCard` over a page's card: the card is `FLOAT_CARD` (a container, the float's
 * positioning parent), the float `FLOAT`: over the card's right, `--float-width` wide and as tall
 * as its content up to the card's height (scrolling inside beyond), from `@3xl`
 * of the card's own width, and in the flow below that (`order-first` puts it above), so a narrow
 * page (the chat open on a laptop, a phone) still reads. While it shows, the card's content takes
 * `FLOAT_ROOM`, so nothing lies under it.
 */
export const FLOAT_CARD = "@container/float relative";
export const FLOAT =
  "m-3 @3xl/float:absolute @3xl/float:top-3 @3xl/float:right-3 @3xl/float:m-0 @3xl/float:max-h-[calc(100%-1.5rem)] @3xl/float:w-(--float-width)";
export const FLOAT_ROOM = "@3xl/float:pr-[calc(var(--float-width)+1.5rem)]";

/** The policies do not hold: said on Workflows and Permissions, as they then refuse everything. */
export function PolicyProblems() {
  return (
    <Notice variant="destructive">
      <code>policies/*.cedar</code> do not hold, so every operation call and run start is refused (
      <code>sanoma check</code> says why).
    </Notice>
  );
}

/**
 * A list page's one card (`FLOAT_CARD`), `--pane-tall` at least: the list (`children`), and the
 * item open (`float`, a `FloatingCard` placed with `FLOAT`) over its right, the list left room.
 */
export function FloatHost({ float, children }: { float: ReactNode; children: ReactNode }) {
  return (
    <Card className={cn(FLOAT_CARD, "min-h-(--pane-tall) gap-0 py-0")}>
      <div className={cn("flex flex-1 flex-col", float && FLOAT_ROOM)}>{children}</div>
      {float}
    </Card>
  );
}

/** A segment while its URL shows, or while Link's `disabled` leaves it no href. */
const SEGMENT = `${CURRENT_LINK} aria-[current=page]:font-semibold aria-disabled:pointer-events-none aria-disabled:opacity-50`;

/**
 * A choice between URLs, as one control: `children` are `Segment`s. Links rather than buttons, so
 * the server renders the choice the URL makes, and each choice is a page of its own.
 */
export function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return <ButtonGroup aria-label={label}>{children}</ButtonGroup>;
}

/** One choice of a `Segmented`: its `<Link>`, as a small outline button. */
export function Segment({ children }: { children: ReactElement }) {
  return (
    <ButtonLink variant="outline" size="sm" className={SEGMENT}>
      {children}
    </ButtonLink>
  );
}

/** A link off the app, in a new tab, which its icon says. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <ButtonLink variant="link" size="sm">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ArrowSquareOutIcon aria-hidden="true" data-icon="inline-end" />
      </a>
    </ButtonLink>
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
 * A box filling its parent, whose content loads and draws in the browser once the box comes near
 * the screen; until then, and on the server, `fallback` holds its place. (The server never sees
 * the box: `useSeen` flips in an effect, and effects run only in the browser.) Bare: a caller that
 * wants a card puts it in a `PanelCard`, or sizes its parent.
 */
function LazyPanel({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  return (
    <div ref={box} className="size-full">
      {seen ? <Suspense fallback={fallback}>{children}</Suspense> : fallback}
    </div>
  );
}

/** A card for a graph or code panel inline in a page, `--pane-short` high. */
export function PanelCard({ children }: { children: ReactNode }) {
  return <Card className="h-(--pane-short) gap-0 py-0">{children}</Card>;
}

/** A graph (a run's, or a workflow's outline) in a LazyPanel, a skeleton of its size holding its place. */
export const GraphPanel = (props: GraphProps) => (
  <LazyPanel fallback={<Skeleton role="status" aria-label="Loading the graph" className="size-full rounded-none" />}>
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
export const CodePanel = (props: CodeProps) => (
  <LazyPanel fallback={<pre className="size-full overflow-auto p-3 font-mono text-xs">{props.source}</pre>}>
    <Code {...props} />
  </LazyPanel>
);

/**
 * An app screen's title row: a `PageHeader` titled by the page's crumb, under the crumbs of the
 * pages above it, each a link.
 */
export function CrumbHeader(props: Omit<PageHeaderProps, "title" | "crumbs">) {
  const crumbs = useCrumbs();
  return (
    <PageHeader
      {...props}
      title={crumbs.at(-1)?.label}
      crumbs={crumbs.slice(0, -1).map(({ id, pathname, label }) => (
        <CrumbLink key={id} to={pathname}>
          {label}
        </CrumbLink>
      ))}
    />
  );
}

/** A page above this one, in a `PageHeader`'s crumbs. */
export function CrumbLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    // Exact: a page above this one is not the page open, so it never takes `aria-current`.
    <Link to={to} activeOptions={{ exact: true }} className="text-muted-foreground hover:text-foreground">
      {children}
    </Link>
  );
}

/** A heading inside a card's section. */
export function SubsectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium">{children}</h3>;
}

/** A card's section: its heading, and what it holds. */
export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <SubsectionTitle>{title}</SubsectionTitle>
      {children}
    </div>
  );
}

/** "Used by" as a page's region: the workflows that may call what the page shows, then the sites' files that call it. */
export function UsedBy(props: UsedByProps) {
  return (
    <Region title="Used by">
      <UsedByList {...props} />
    </Region>
  );
}

interface UsedByProps {
  workflows?: { name: string; title?: string | undefined }[];
  sites?: SiteCaller[];
}

/**
 * What calls something: each workflow, linking to its page, then each site's file under the
 * site's title and how it calls (a page this build serves links to itself, but one with a path
 * parameter, which has no one URL; a component's file names the file).
 */
export function UsedByList({ workflows = [], sites = [] }: UsedByProps) {
  const { routesByPath } = useRouter();
  if (!workflows.length && !sites.length) return <None />;
  return (
    <ItemGroup>
      {workflows.map((wf) => (
        <LinkItem key={wf.name} variant="outline" size="xs">
          <Link to="/workflows/$name" params={{ name: wf.name }}>
            <ItemContent>
              <ItemTitle>{wf.title ?? wf.name}</ItemTitle>
            </ItemContent>
            {CHEVRON}
          </Link>
        </LinkItem>
      ))}
      {sites.map(({ site, file, page, via }) => {
        const content = (
          <ItemContent>
            <ItemTitle>
              {site}
              <code className="font-normal text-muted-foreground">{page ?? file}</code>
            </ItemTitle>
            <ItemDescription>through {via.join(" and ")}</ItemDescription>
          </ItemContent>
        );
        return page && hasOneUrl(page) && page in routesByPath ? (
          <LinkItem key={file} variant="outline" size="xs">
            <Link to={page}>
              {content}
              {CHEVRON}
            </Link>
          </LinkItem>
        ) : (
          <Item key={file} role="listitem" variant="outline" size="xs">
            {content}
          </Item>
        );
      })}
    </ItemGroup>
  );
}

/** The end of a row that links elsewhere. */
const CHEVRON = (
  <ItemActions>
    <CaretRightIcon aria-hidden="true" className="size-4" />
  </ItemActions>
);

/** What a section says when it has nothing to list. */
export function None({ children = "None." }: { children?: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

/** Who asked for an approval: "the policy (<its rules' ids>), holding <op>" or "the workflow". */
export function RequestedBy({ requestedBy, op, reasons }: Pick<ApprovalState, "requestedBy" | "op" | "reasons">) {
  if (requestedBy !== "policy") return "the workflow";
  return (
    <>
      the policy
      {reasons?.length ? (
        <>
          {" "}
          (<code>{reasons.join(", ")}</code>)
        </>
      ) : null}
      , holding <code>{op}</code>
    </>
  );
}

/** After a decision the run's starter made because nobody else could (`alone`). */
export const ALONE = " (nobody else could)";

/** The note a decider left, quoted on its own line. */
export function DecisionNote({ note }: { note: string }) {
  return <q className="block text-muted-foreground italic">{note}</q>;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What is wrong in the data files: their resources are left out until it is fixed. */
export function Problems({ problems }: { problems: ResourceProblem[] }) {
  return (
    <Alert variant="destructive">
      <WarningCircleIcon aria-hidden="true" />
      <AlertTitle>{plural(problems.length, "problem")} in the data files: their resources are left out</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {problems.map((p, i) => (
            // Two problems may share a place and a message: the list never reorders.
            <li key={i}>
              {p.file && <code>{problemAt(p)}</code>} {p.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** A vendor's id, cut short (`shortId`), the whole of it in its title. */
export const ShortId = ({ id, className }: { id: string; className?: string }) => (
  <code className={className} title={id}>
    {shortId(id)}
  </code>
);
