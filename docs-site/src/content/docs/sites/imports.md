---
title: A site's imports
description: "A site's route file imports createFileRoute from @tanstack/react-router (the route generator rewrites the path there, and only there) and the rest from sanoma/site, which is this package's sanoma/site."
sidebar:
  order: 3
---

A site's route file imports `createFileRoute` from `@tanstack/react-router` (the route generator rewrites the path there, and only there) and the rest from `sanoma/site`, which is this package's `sanoma/site`: the app's own router's `Link`, `Outlet`, `useNavigate`, `useParams`, `useSearch`, `useRouter`, `useRouterState`, `getRouteApi`, `linkOptions`, `redirect` and `notFound` (and their types), `defineSite`, `api` with `ApiError` and `errorBodyOf` ([Calling operations and workflows](/sites/calling/)), `content`, the repo's Markdown ([Content](/sites/content/)), a public site's languages, `defineMessages`, `useMessages`, `useLocale` and `useLocales` ([Languages](/sites/languages/)), `siteOrigin` and `siteUrl`, a page's absolute URLs ([Public sites](/sites/public-sites/)), and the pieces that talk to the app, `RunForm` and `useActor` ([The kit and RunForm](/sites/kit/)). How a page looks comes from `sanoma/ui`. `sites/<name>/site.ts`, optional, names the site, and may give it an icon, a [Lucide](https://lucide.dev/icons) icon's name as a literal (`icon: "kanban"`), read without running the file (one that is not a literal is no icon):

```ts
// sites/help/site.ts
import { defineSite } from "sanoma/site";

export default defineSite({ title: "Help desk", icon: "life-buoy" });
```

```tsx
// sites/help/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "sanoma/site";

export const Route = createFileRoute("/sites/help/")({ component: Home });

function Home() {
  return <Link to="/workflows">Workflows</Link>;
}
```

## What site.ts sets

`title` names the site in the app (its folder's name without one) and `icon` is its tile's icon in the bar, a [Lucide](https://lucide.dev/icons) icon's name (without one, a globe for a public site and a window for one in the app only). A site for visitors rather than people says so in `site.ts`: `defineSite({ title: "Website", public: true, login: "auth0" })`. `public: true` makes it a public site, served at the root of its own host to visitors; `login`, for a public site only, names the connector in `sanoma.config.ts` whose login half signs a visitor in (`withSetup`'s `login`, in [the workflows README](/workflows/writing-workflows/)), and without it every page runs as `anonymous`. `locales`, for a public site with no login, names its languages ([Languages](/sites/languages/)). `sanoma` loads `site.ts` (`defineSite` served by the runtime's loader) and checks its default export, `defineSite({ … })`, against these options: a key it does not take, a value of the wrong kind, a `login` naming no login half or `locales` where they do not apply is a problem `sanoma check` names. A public site is served at the root of its own host too ([Public sites](/sites/public-sites/)).
