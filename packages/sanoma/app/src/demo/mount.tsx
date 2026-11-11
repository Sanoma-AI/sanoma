// A demo's entry, `mount.js` (`demo-build.ts`): the company's sites rendered into an element of
// the host's page, their workflows run in the page over the connectors' fakes, from the world.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { description, routeTree, runtime, sites } from "virtual:sanoma/demo";
import { PagePending, SiteError, SiteNotFound } from "../components/boundaries.tsx";
import { configQuery } from "../queries.ts";
import { serve } from "./api.ts";
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet, which the build emits as demo.css
import "./demo.css";

export interface MountOptions {
  /** The page shown first, as the app has it: `/sites/<site>/…` (an app's `/sites/<app>/<site>/…`). The first site's home unless given. */
  path?: string;
  /**
   * Called with the path a link (a router's, or a plain one to the host's origin) leads to outside
   * the sites, an app page's, instead of going there: the visitor leaves the demo.
   */
  exit?: (path: string) => void;
}

/** Whether `pathname` is a page of the sites, which the demo shows (else the visitor leaves it). */
const inSites = (pathname: string) => sites.some((site) => `${pathname}/`.startsWith(`/sites/${site}/`));

/** The attribute `mount` sets on its element, which every rule of `demo.css` is scoped to. */
const SCOPE = "data-sanoma-demo";

/** Each element's latest `mount` call, by its runtime: one still seeding when another is called on its element never renders. */
const latest = new WeakMap<Element, Promise<unknown>>();

/**
 * Renders the sites into `element`, from `path`, on a history of their own (the host's URL and
 * history untouched), over a fresh runtime seeded from the world. Resolves to the unmount, which
 * empties the element and stops the runtime (`stop`: its runs dropped, a sleeping one's timer
 * with it); one that another `mount` on the element overtook while it seeded renders
 * nothing and resolves to an unmount that does nothing. `api` is its runtime's (`serve`).
 */
export async function mount(element: Element, { path = `/sites/${sites[0]}`, exit }: MountOptions = {}) {
  // Served in the order mounts are called, not as their worlds seed.
  const seeding = runtime();
  latest.set(element, seeding);
  const release = serve(seeding);
  seeding.catch(release);
  const page = await seeding;
  if (latest.get(element) !== seeding) {
    release();
    return () => {};
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1_000 } } });
  // What a site's start form reads of the config, never asked of a server.
  queryClient.setQueryData(configQuery().queryKey, description);
  const history = createMemoryHistory({ initialEntries: [path] });
  const unblock = history.block({
    blockerFn: ({ nextLocation }) => {
      if (inSites(nextLocation.pathname)) return false;
      exit?.(nextLocation.href);
      return true;
    },
  });
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultErrorComponent: SiteError,
    defaultNotFoundComponent: SiteNotFound,
    defaultPendingComponent: PagePending,
  });
  // A plain link of the sites' to this origin goes through the router too, never the host's page,
  // its href read from the demo's page, not the host's. Listened to after `createRoot`, whose own
  // listener on the element runs first: a handler's `preventDefault` (a `<Link>`'s) is seen here.
  const onClick = (event: Event) => {
    const link = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
    const { button, metaKey, ctrlKey, shiftKey, altKey } = event as MouseEvent;
    if (!link || event.defaultPrevented || button !== 0 || metaKey || ctrlKey || shiftKey || altKey) return;
    if ((link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const url = new URL(link.getAttribute("href")!, new URL(router.state.location.href, location.origin));
    if (url.origin !== location.origin) return;
    event.preventDefault();
    void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
  };
  element.setAttribute(SCOPE, "");
  const root = createRoot(element);
  element.addEventListener("click", onClick);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return () => {
    element.removeEventListener("click", onClick);
    root.unmount();
    unblock();
    release();
    page.stop();
    queryClient.clear();
    element.removeAttribute(SCOPE);
  };
}
