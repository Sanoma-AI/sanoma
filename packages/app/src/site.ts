// What a site imports, as `sanoma/site` (`@sanoma-ai/app/site`): `defineSite`, the route APIs of
// the app's own TanStack Router, so a site and the app share one router, `api`, which calls the
// app's server function, `ApiError` and `errorBodyOf`, how a refusal reads, and `content`, the
// repo's Markdown. Source, loaded only by Vite in a company's build; browser code, nothing
// server-side. A route file still imports `createFileRoute` from `@tanstack/react-router` itself:
// the route generator rewrites its path there, and only there.
import type { ComponentType } from "react";
import { type Api, createApi } from "./api-client.ts";
import { callFn } from "./functions.ts";

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

export type { Api, Register } from "./api-client.ts";
// The repo's `content/`, typed by `.sanoma/content.ts` through `Register` as `api` is by `.sanoma/api.ts`.
export { content } from "./content.ts";
export type { Content, ContentEntry, ContentKind, ContentSummary } from "./content.ts";
// A refusal of `api`: an `ApiError`, whose `body` (`errorBodyOf(err)`) has the stable `code`.
export { ApiError, errorBodyOf } from "./api.ts";
export type { ErrorResponse } from "./api.ts";
// What `.sanoma/api.ts` types the company's `api` with: a company resolves `sanoma/site`, not the runtime.
export type { CollectionApi, ListQuery, OpFn, Saved, WorkflowFn } from "@sanoma-ai/workflows/shared";

/**
 * The company's operations and workflows, called as the person on the page (`callFn`): a loader's
 * call runs in-process while the server renders the page, as the person whose request it is.
 */
export const api: Api = createApi((request) => callFn({ data: request }));

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
