---
title: A site's imports
description: "Find the import for a site route, router helper, workflow call, or UI component."
sidebar:
  order: 3
---

In a route file, import `createFileRoute` from `@tanstack/react-router`. The route generator rewrites the path in that import’s call. Get the other routing helpers from `sanoma/site` so the page uses the app’s router.

| What you need                                         | Exports from `sanoma/site`                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation and routes                                 | `Link`, `Outlet`, `useNavigate`, `useParams`, `useSearch`, `useRouter`, `useRouterState`, `getRouteApi`, `linkOptions`, `redirect`, `notFound`, and their types |
| Site definition                                       | `defineSite`                                                                                                                                                    |
| [Operations and workflows](/sites/calling/)           | `api`, `ApiError`, `errorBodyOf`                                                                                                                                |
| [Markdown in the repo](/sites/content/)               | `content`                                                                                                                                                       |
| [Languages](/sites/languages/)                        | `defineMessages`, `useMessages`, `useLocale`, `useLocales`                                                                                                      |
| [Absolute URLs](/sites/public-sites/)                 | `siteOrigin`, `siteUrl`                                                                                                                                         |
| [Workflow forms and the signed-in actor](/sites/kit/) | `RunForm`, `useActor`                                                                                                                                           |

Import visual components from `sanoma/ui`. To set a title and icon, add the optional `sites/<name>/site.ts`. Use a literal [Lucide icon name](https://lucide.dev/icons), such as `icon: "kanban"`. Sanoma reads the file without running it and omits the icon if its name is computed.

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

Export `defineSite({ … })` as the default from `sites/<name>/site.ts`. For example, `defineSite({ title: "Website", public: true, login: "auth0" })` serves a site for visitors and uses the configured Auth0 connector for sign-in.

| Option    | Effect                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`   | Names the site in the app. Defaults to the folder name.                                                                                                                                                                    |
| `icon`    | Names the tile’s [Lucide icon](https://lucide.dev/icons). The default is a globe for a public site or a window for an app-only site.                                                                                       |
| `public`  | When true, serves the site at the root of [its own host](/sites/public-sites/).                                                                                                                                            |
| `login`   | For a public site, names the connector in `sanoma.config.ts` with the visitor [login implementation](/workflows/writing-workflows/) attached through `withSetup`. Without it, pages on the public host run as `anonymous`. |
| `locales` | Lists the [languages](/sites/languages/) of a public site without a login.                                                                                                                                                 |

The runtime loader supplies `defineSite` when Sanoma loads the file. `sanoma check` reports unknown options, incorrect value types, a login without a matching connector implementation, and locales on an ineligible site.
