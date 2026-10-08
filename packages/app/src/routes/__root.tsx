import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts, useMatchRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@/components/ui/navigation-menu";
import { Toaster } from "@/components/ui/sonner";
import { ActorContext, useActor, useActorState } from "../actor.ts";
import { Notice } from "../components/common.tsx";
import { ModeToggle } from "../components/mode-toggle.tsx";
import { ThemeProvider, ThemeScript } from "../components/theme-provider.tsx";
import css from "../style.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "Sanoma" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  // Pages show what is happening now: never cache them.
  headers: () => ({ "cache-control": "no-store" }),
  component: Root,
  notFoundComponent: () => <Notice tone="bad">There is no page here.</Notice>,
  // The router types a boundary's error as unknown: anything can be thrown.
  errorComponent: ({ error }) => (
    <Notice tone="bad">Something went wrong: {error instanceof Error ? error.message : String(error)}</Notice>
  ),
});

function Root() {
  const actor = useActorState();
  return (
    <Document>
      <ThemeProvider>
        <ActorContext value={actor}>
          <div id="app">
            <Nav />
            <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
              <Outlet />
            </main>
            <WhoAreYou open={actor.actor === null} />
            <Toaster />
          </div>
        </ActorContext>
      </ThemeProvider>
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    // The theme script sets the class on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

const PAGES = [
  { to: "/runs", label: "Runs" },
  { to: "/inbox", label: "Inbox" },
  { to: "/start", label: "Start" },
  { to: "/workflows", label: "Workflows" },
] as const;

function Nav() {
  const { actor, setActor } = useActor();
  const matchRoute = useMatchRoute();
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link to="/runs" className="font-heading text-base font-semibold">
          Sanoma
        </Link>
        <NavigationMenu viewport={false} className="order-last basis-full justify-start sm:order-none sm:basis-auto">
          <NavigationMenuList>
            {PAGES.map(({ to, label }) => (
              <NavigationMenuItem key={to}>
                <NavigationMenuLink asChild active={Boolean(matchRoute({ to, fuzzy: true }))}>
                  <Link to={to}>{label}</Link>
                </NavigationMenuLink>
              </NavigationMenuItem>
            ))}
          </NavigationMenuList>
        </NavigationMenu>
        <div className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
          {actor && (
            <>
              <span>
                You are <strong className="text-foreground">{actor}</strong>
              </span>
              <Button variant="link" size="sm" onClick={() => setActor(null)}>
                change
              </Button>
            </>
          )}
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}

/** There is no login. The name is kept in this browser and sent with every change. */
function WhoAreYou({ open }: { open: boolean }) {
  const { setActor } = useActor();
  const [name, setName] = useState("");
  return (
    // No way out but a name: every change needs one.
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setActor(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Who are you?</DialogTitle>
            <DialogDescription>
              Runs you start and approvals you decide are recorded under this name. Use the name approvals ask for, such
              as <code>marketing-lead</code>. There is no login: this is a local tool.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="who-name">Your name</FieldLabel>
              <Input
                id="who-name"
                autoFocus
                autoComplete="username"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="marketing-lead"
              />
            </Field>
            <Button type="submit" disabled={!name.trim()}>
              Continue
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
