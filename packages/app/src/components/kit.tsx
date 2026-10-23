import { useRender } from "@base-ui/react/use-render";
import type { Effect } from "@sanoma-ai/workflows";
import { cva, type VariantProps } from "class-variance-authority";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { type ComponentProps, type ReactElement, type ReactNode, useId } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { CardTitle } from "#/components/ui/card.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "#/components/ui/empty.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
import { cn } from "#/lib/utils.ts";
import { type Tone, TONE_FILL } from "#/lib/tone.ts";

// The kit's own pieces, composed from the shadcn components in ./ui: how a page looks, nothing
// that talks to the app (test/ui.test.ts). They take what they show as props and import only ./ui,
// the tones and `cn`. `sanoma/ui` exports those its list names (ui.ts); the start form shares the
// rest without reaching ./common.tsx, the app's own pieces that may read the app.

/** Badge colours by tone, over Badge's default variant. */
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

/**
 * A badge in a tone's colours: what a status means, the same everywhere (the --tone-* tokens).
 * With `dot`, a status pill: the tone's dot before the label.
 */
export function ToneBadge({
  tone,
  dot = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Badge>, "className" | "variant"> & { tone: Tone; dot?: boolean }) {
  return (
    <Badge {...props} className={toneBadge({ tone })}>
      {dot && <StatusDot tone={tone} className="size-1.5" />}
      {children}
    </Badge>
  );
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

/** A tone as a dot, where a badge would be too much. */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", TONE_FILL[tone], className)} />;
}

/**
 * A tooltip on a control. Only on what takes focus (a button, a link, or a badge given
 * `tabIndex={0}` because its tooltip says something it does not), so a keyboard reaches it too.
 * Passive detail on many items, such as a time's exact value, is a native `title` instead.
 * Base UI's tooltip describes nothing, so the tip is also the trigger's `aria-describedby`
 * through a hidden copy; `describe={false}` when the trigger's name already says it.
 */
export function Tip({
  tip,
  describe = true,
  children,
}: {
  tip: ReactNode;
  describe?: boolean;
  children: ReactElement;
}) {
  const id = useId();
  return (
    <Tooltip>
      <TooltipTrigger render={children} aria-describedby={describe ? id : undefined} />
      {describe && (
        <span id={id} hidden>
          {tip}
        </span>
      )}
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A link drawn as a Button: `children` is the `<Link>` or `<a>`, given Button's classes and slot.
 * Not Button with `render`: Base UI's Button makes what it renders `role="button"`, and this is
 * still a link.
 */
export function ButtonLink({
  variant,
  size,
  className,
  children,
}: VariantProps<typeof buttonVariants> & { className?: string; children: ReactElement }) {
  return useRender({
    render: children,
    props: { "data-slot": "button", className: cn(buttonVariants({ variant, size }), className) },
  });
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
      {variant === "destructive" ? <WarningCircleIcon aria-hidden="true" /> : <InfoIcon aria-hidden="true" />}
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
 * A page's heading row: its <h1>, `title` after `icon` when given, whatever sits beside it, and
 * the page's `action` at the far end.
 */
export function PageHeader({ title, icon, children, action }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="flex items-center gap-2 text-lg">
        {icon}
        {title}
      </h1>
      {children}
      {action && <div className="ml-auto">{action}</div>}
    </header>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

/** A section's heading, under the page's. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-base font-medium">{children}</h2>;
}

/** A titled region of a page: its <h2>, and what it holds. */
export function Region({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-(--gap-section)">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

/**
 * A selection shown over the right of a page's card (a selected node, an open run, an open
 * approval): a card with the large corner and the one card with a shadow. The caller places it
 * (`className`, e.g. `absolute top-3 right-3 w-80`) in a `relative` parent.
 */
export function FloatingCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="floating-card"
      className={cn("flex flex-col rounded-xl border bg-card text-sm text-card-foreground shadow-lg", className)}
      {...props}
    />
  );
}

/** Label and value pairs, as a description list of `Fact`s: labels in one column, values in the other. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 compact:gap-y-0.5">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere">{children}</dd>
    </>
  );
}

/**
 * A card's title as a heading: an `<h2>` in CardTitle, whose type it inherits (Tailwind's preflight
 * leaves a heading's size and weight to its parent). CardTitle is a `<div>` with no `render`.
 */
export function CardHeading({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <CardTitle className={className}>
      <h2>{children}</h2>
    </CardTitle>
  );
}

/**
 * An icon button with a tooltip: ghost and icon-sized unless props say otherwise, named `label`
 * (its `aria-label`; `tip` unless given) and showing `tip`, which describes it unless the name
 * already says it (`describe` overrides).
 */
export function TipButton({
  tip,
  label = tip,
  describe = !label.toLowerCase().includes(tip.toLowerCase()),
  variant = "ghost",
  size = "icon",
  ...props
}: { tip: string; label?: string; describe?: boolean } & Omit<ComponentProps<typeof Button>, "aria-label">) {
  return (
    <Tip tip={tip} describe={describe}>
      <Button variant={variant} size={size} aria-label={label} {...props} />
    </Tip>
  );
}
