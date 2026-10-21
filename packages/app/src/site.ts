// What a site imports, as `sanoma/site` (`@sanoma-ai/app/site`): `defineSite` and the route APIs
// of the app's own TanStack Router, so a site and the app share one router. Source, loaded only by
// Vite in a company's build; browser code, nothing server-side. A route file still imports
// `createFileRoute` from `@tanstack/react-router` itself: the route generator rewrites its path
// there, and only there.
import type { ComponentType } from "react";

export {
  getRouteApi,
  Link,
  linkOptions,
  notFound,
  Outlet,
  redirect,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
export type {
  LinkOptions,
  LinkProps,
  NavigateOptions,
  NotFoundError,
  Redirect,
  UseNavigateResult,
} from "@tanstack/react-router";

// Lane A4 adds here: export { api, type Api, type Register } from "./api-client.ts";

/** A site's `sites/<name>/site.ts` (optional): how the app's Sites panel names it. */
export interface SiteDefinition {
  /** The site's name in the Sites panel and its crumb; the folder's name when not given. */
  title?: string;
  /** An icon beside its title: a component that takes a `className`. */
  icon?: ComponentType<{ className?: string }>;
}

/** A site's definition, the default export of `sites/<name>/site.ts`: `export default defineSite({ title: "Help desk" })`. */
export function defineSite(site: SiteDefinition): Readonly<SiteDefinition> {
  return Object.freeze({ ...site });
}
