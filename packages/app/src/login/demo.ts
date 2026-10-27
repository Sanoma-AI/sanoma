import type { PeopleResource } from "@sanoma-ai/workflows";
import { personsOf } from "@sanoma-ai/workflows/shared";
import { DEMO_AS } from "../api.ts";
import type { LoginProvider } from "../context.ts";
import { cookie, cookies } from "./github.ts";
import { escapeHtml, smallPage } from "./page.ts";

// The demo login: everyone is one of the company's people. A visitor is whoever a link names
// (`?as=<id>`, a moment's link), kept in a cookie, else the first person the data files declare;
// `admitting` then admits them as declared, as for any login. Every vendor is a fake in a demo,
// and the instance is seeded afresh every hour, so being anyone costs nothing; anywhere else it
// would let anyone act as anyone, so it runs only in a demo.

/** The demo login's name. */
export const DEMO = "demo";

/** The cookie keeping whom a visitor is: a person's id, set by a link's `?as=`. */
export const DEMO_COOKIE = "sanoma_demo_as";

/** How long it keeps them: a day, many of the demo's hourly reseeds. */
const DEMO_COOKIE_SECONDS = 24 * 60 * 60;

/**
 * The demo login over `people` (`readPeople`'s, read at each request): `?as=<id>` on a page's
 * GET sets the cookie and redirects to the same URL without it (a 404 page for an id nobody has);
 * `resolveActor` is the person the cookie names, or the first person when it names nobody
 * declared. `check` refuses an app not started as a demo.
 */
export function demoLogin(people: () => readonly PeopleResource[]): LoginProvider {
  const persons = () => personsOf(people());
  return {
    name: DEMO,
    check(_listenHost, started) {
      if (started?.demo) return;
      throw new Error(
        "The demo login signs anyone in as any of the company's people, so it runs only in a demo: start the app with `demo: true` (`sanoma demo`)",
      );
    },
    resolveActor(request) {
      const all = persons();
      const kept = cookies(request)[DEMO_COOKIE];
      const id = all.find((p) => p.id === kept)?.id ?? all[0]?.id;
      return id === undefined ? undefined : { id };
    },
    handle(request) {
      const url = new URL(request.url);
      const as = url.searchParams.get(DEMO_AS);
      if (as === null || request.method !== "GET") return undefined;
      if (!persons().some((p) => p.id === as)) {
        return smallPage(
          404,
          "Nobody of that name",
          `<p>This demo has nobody called ${escapeHtml(as)}.</p><p><a href="/">Open the demo</a></p>`,
        );
      }
      url.searchParams.delete(DEMO_AS);
      // One leading slash: `//host/` would send the visitor to another site.
      const location = `/${url.pathname.replace(/^\/+/, "")}${url.search}`;
      return new Response(null, {
        status: 303,
        headers: {
          location,
          // Lax, as the logins' cookies: a moment's link from another site (the public site's solution page) sets it.
          "set-cookie": cookie(request, DEMO_COOKIE, as, "/", DEMO_COOKIE_SECONDS),
          "cache-control": "no-store",
        },
      });
    },
  };
}
