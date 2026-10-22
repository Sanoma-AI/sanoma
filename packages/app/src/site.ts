// What a site imports that talks to the running app, as `sanoma/site` (`@sanoma-ai/app/site`); how
// a page looks is `sanoma/ui`'s. The app's own router's APIs, so a site and the app share one
// router. Source, loaded only by Vite in a company's build; browser code, nothing server-side. A
// route file still imports `createFileRoute` from `@tanstack/react-router` itself: the route
// generator rewrites its path there, and only there.
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

export type { Api, Register } from "./api-client.ts";
// The repo's `content/`, typed by `.sanoma/content.ts` through `Register` as `api` is by `.sanoma/api.ts`.
export { content } from "./content.ts";
export type { Content, ContentEntry, ContentKind, ContentSummary } from "./content.ts";
// A refusal of `api`: an `ApiError`, whose `body` (`errorBodyOf(err)`) has the stable `code`.
export { ApiError, errorBodyOf } from "./api.ts";
export type { ErrorResponse } from "./api.ts";
// What `.sanoma/api.ts` types the company's `api` with: a company resolves `sanoma/site`, not the runtime.
export type { CollectionApi, ListQuery, OpFn, Saved, WorkflowFn } from "@sanoma-ai/workflows/shared";
// A workflow's start form (`<RunForm workflow="hello" />`), and who is on the page.
export { RunForm } from "./form/run-form.tsx";
export { type ActorState, useActor } from "./actor.ts";
export { api } from "./queries.ts";

/**
 * A site's `sites/<name>/site.ts` (optional): how the app's Sites panel names it, and whether it
 * is public. `sanoma` reads `title`, `public` and `login` without running the file.
 */
export interface SiteDefinition {
  /** The site's name in the Sites panel and its crumb; the folder's name when not given. */
  title?: string;
  /** An icon beside its title: a component that takes a `className`. */
  icon?: ComponentType<{ className?: string }>;
  /** Served at the root of its own domain to visitors, not people (a literal: read without running site.ts). */
  public?: boolean;
  /** The connector in sanoma.config.ts whose login half signs visitors in; left out, every page runs as `anonymous`. */
  login?: string;
}

/**
 * A site's definition, the default export of `sites/<name>/site.ts`: `export default defineSite({ title: "Help desk" })`,
 * or for visitors `defineSite({ title: "Website", public: true, login: "auth0" })`.
 */
export function defineSite(site: SiteDefinition): Readonly<SiteDefinition> {
  return Object.freeze({ ...site });
}
