import { type QueryClient, useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { ThemeProvider } from "next-themes";
import { lazy, type ReactNode } from "react";
import { DENSITY_COOKIE } from "#/components/density.tsx";
import { CHAT_COOKIE, chatPref, type ChatPref } from "#/components/shell/prefs.ts";
import { ActorContext, useActorState } from "../actor.ts";
import { actorQuery, configQuery, waitingRunsQuery } from "../queries.ts";
// Phosphor's regular shield-check, the app's icon.
import favicon from "../favicon.svg?url";
import css from "../style.css?url";

/** The app's chrome, in a chunk of its own that a public site's host never loads. */
const Root = lazy(() => import("#/components/app-chrome.tsx"));

// One root for both hosts (a route tree has one): on a public site's host (`context.site`), a
// bare document around the site's own pages, with nothing of the app's but its scripts; on the
// app's, the app's head, loader and chrome.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient; site?: string }>()({
  // Annotated: without it, tsc infers the match's context as `never`.
  head: ({ match, matches }: { match: { context: { site?: string } }; matches: Match[] }) =>
    match.context.site ? (matches.some(isLost) ? LOST_HEAD : BARE_HEAD) : APP_HEAD,
  // Pages show what is happening now: never cache them.
  headers: () => ({ "cache-control": "no-store" }),
  loader: async ({ context }): Promise<Prefs | null> => (context.site ? null : appLoader(context.queryClient)),
  // The document, around everything the root renders: its page, error or not-found included.
  shellComponent: Document,
  component: RootSwitch,
});

const META = [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }];

/**
 * A public site's head: the site's layout sets its own icon and stylesheet, and its pages their
 * titles. No color-scheme: the browser's light, unless the site's stylesheet declares its own.
 */
const BARE_HEAD = { meta: META };

/**
 * A public site's page not found: a path no page has (`_notFound`, on the route that draws it), or
 * a loader's notFound(). Its title, unless a route's head gives one.
 */
const LOST_HEAD = { meta: [...META, { title: "Page not found" }] };

// `_notFound` is TanStack's own field (its Match draws the not-found page by it): a rename shows in test/sites-build.test.ts.
type Match = { status: string; _notFound?: boolean };
const isLost = ({ status, _notFound }: Match) => _notFound === true || status === "notFound";

/**
 * A public site's document has a body with no margin, in a layer of its own ahead of the head's
 * stylesheets, so it comes below any layer of the site's: a site's stylesheet overrides it.
 */
const BARE_RESET = "@layer sanoma{body{margin:0}}";

const APP_HEAD = {
  meta: [...META, { name: "color-scheme", content: "light dark" }, { title: "Sanoma" }],
  links: [
    { rel: "stylesheet", href: css },
    // Without an icon the browser asks for /favicon.ico, and gets a 404.
    { rel: "icon", type: "image/svg+xml", href: favicon },
  ],
};

/**
 * What the app's root loader returns: whether the chat column was left open or folded (neither
 * until Chat is first used), and the density.
 */
interface Prefs {
  chat: ChatPref;
  compact: boolean;
}

/**
 * Who the server says is asking, in the first render: a deployment's login shows at once. And
 * the config, which every page reads and which cannot change while the app runs. Both stay in
 * the query client, where the page reads them: a loader returns only what no query holds (here,
 * the `Prefs`), since the page carries loader data too.
 */
async function appLoader(queryClient: QueryClient): Promise<Prefs> {
  // The inbox badge's count, started here and not awaited: it streams in with the page, and a
  // slow or failed read never holds the page up (the badge shows nothing until it comes).
  void queryClient.query(waitingRunsQuery()).catch(() => {});
  await Promise.all([
    queryClient.query({ ...actorQuery(), staleTime: "static" }),
    queryClient.query({ ...configQuery(), staleTime: "static" }),
  ]);
  return readPrefs();
}

/** A public site's pages alone, on its host; else the app's chrome around the page. */
function RootSwitch() {
  return useRouter().options.context.site ? (
    <SiteActor>
      <Outlet />
    </SiteActor>
  ) : (
    <Root />
  );
}

/**
 * On a public site's host, who the page is for, as `useActor()` reads it: the visitor the site's
 * login verifies, or nobody (`anonymous`), asked once the page is in the browser; not read
 * (`actor` undefined) until then. One provider throughout, so the page never remounts.
 */
function SiteActor({ children }: { children: ReactNode }) {
  const { data } = useQuery(actorQuery());
  const actor = useActorState(data ?? { fromServer: true, actor: null });
  return <ActorContext value={data ? actor : { ...actor, actor: undefined }}>{children}</ActorContext>;
}

/**
 * Whether the chat column was left open or folded (its cookie, unset until Chat is used) and whether the
 * page is Compact (DensityProvider says why a cookie), from the request's cookies on the server
 * and `document.cookie` in the browser. Each takes its value once, as it mounts: the first render
 * is hydration, which has the server's answer; reading it in the browser too keeps a later
 * remount (an error boundary's retry, say) on the cookie's side for both.
 */
const readPrefs = createIsomorphicFn()
  .server(() => ({
    chat: chatPref(getCookie(CHAT_COOKIE)),
    compact: getCookie(DENSITY_COOKIE) === "compact",
  }))
  .client(() => ({
    chat: chatPref(cookieValue(CHAT_COOKIE)),
    compact: cookieValue(DENSITY_COOKIE) === "compact",
  }));

/** A cookie's value in the browser, or undefined when it is not set. */
function cookieValue(name: string) {
  return document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function Document({ children }: { children: ReactNode }) {
  // On a public site's host, `data-site` tells the browser's router which site this is, and the
  // site brings its own look: no theme.
  const site = useRouter().options.context.site;
  return (
    // next-themes' script sets the class on <html> before the body paints, so React finds it changed.
    <html lang="en" data-site={site} suppressHydrationWarning={!site}>
      <head>
        {site && (
          <style href="sanoma-bare" precedence="sanoma">
            {BARE_RESET}
          </style>
        )}
        <HeadContent />
      </head>
      <body>
        {site ? (
          children
        ) : (
          /* Light, dark or the system's, kept in localStorage. style.css sets color-scheme with the class. */
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            enableColorScheme={false}
            storageKey="sanoma.theme"
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        )}
        <Scripts />
      </body>
    </html>
  );
}
