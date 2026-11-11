import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, notFound, Outlet } from "@tanstack/react-router";
import { type PageLanguages, pageLanguages } from "#/lib/locales.ts";
import { ActorContext, type ActorState } from "../actor.ts";

// A demo's root (`demo-build.ts`'s route tree, over the sites alone): what the app's root gives a
// public site's page, its language, and who it is for, an anonymous visitor, with no document
// around it, since the demo is inside the host's page.

/** The page runtime's caller, `anonymous`: nobody the page can name or change. */
const VISITOR: ActorState = { actor: null, groups: [], fromServer: true, setActor: () => {} };

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // As the app's root (routes/__root.tsx).
  beforeLoad: async ({ matches, buildLocation }): Promise<PageLanguages> => {
    const languages = await pageLanguages(
      matches.at(-1),
      // oxlint-disable-next-line typescript/no-explicit-any -- any page's path, typed by none
      (to, params) => buildLocation({ to: to as any, params: params as any }).publicHref,
    );
    if (languages === "notFound") throw notFound();
    return languages;
  },
  component: () => (
    <ActorContext value={VISITOR}>
      <Outlet />
    </ActorContext>
  ),
});
