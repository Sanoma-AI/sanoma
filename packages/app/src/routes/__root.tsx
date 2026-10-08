import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { lazy, type ReactNode, Suspense } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { ActorContext, useActor, useActorState } from "../actor.ts";
import { Notice } from "../components/common.tsx";
import { ModeToggle } from "../components/mode-toggle.tsx";
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
  notFoundComponent: () => <Notice variant="destructive">There is no page here.</Notice>,
  // The router types a boundary's error as unknown: anything can be thrown.
  errorComponent: ({ error }) => (
    <Notice variant="destructive">
      Something went wrong: {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
});

/** Asked once per browser, so loaded only when no name is stored. */
const WhoAreYou = lazy(() => import("../components/who-are-you.tsx"));

function Root() {
  const actor = useActorState();
  return (
    <Document>
      {/* Light, dark or the system's, kept in localStorage. style.css sets color-scheme with the class. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        enableColorScheme={false}
        storageKey="sanoma.theme"
        disableTransitionOnChange
      >
        <ActorContext value={actor}>
          <div id="app">
            <Nav />
            <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
              <Outlet />
            </main>
            {actor.actor === null && (
              <Suspense fallback={null}>
                <WhoAreYou />
              </Suspense>
            )}
            <Toaster />
          </div>
        </ActorContext>
      </ThemeProvider>
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    // next-themes' script sets the class on <html> before the body paints, so React finds it changed.
    <html lang="en" suppressHydrationWarning>
      <head>
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
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
        <Link to="/runs" className="font-heading text-base font-semibold">
          Sanoma
        </Link>
        <nav className="order-last flex basis-full gap-1 sm:order-none sm:basis-auto">
          {PAGES.map(({ to, label }) => (
            <Button key={to} asChild variant="ghost" size="sm">
              <Link
                to={to}
                activeOptions={{ exact: false }}
                activeProps={{ "data-active": "", "aria-current": "page" }}
                className="data-[active]:bg-muted"
              >
                {label}
              </Link>
            </Button>
          ))}
        </nav>
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
