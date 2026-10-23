// What a site imports that talks to the running app, as `sanoma/site` (`@sanoma-ai/app/site`); how
// a page looks is `sanoma/ui`'s. The app's own router's APIs, so a site and the app share one
// router. Source, loaded only by Vite in a company's build; browser code, nothing server-side. A
// route file still imports `createFileRoute` from `@tanstack/react-router` itself: the route
// generator rewrites its path there, and only there.
import type { ComponentType } from "react";
import { usePageLanguages } from "./lib/locales.ts";

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
export type { Content, ContentEntry, ContentKind, ContentOptions, ContentSummary } from "./content.ts";
// A refusal of `api`: an `ApiError`, whose `body` (`errorBodyOf(err)`) has the stable `code`.
export { ApiError, errorBodyOf } from "./api.ts";
export type { ErrorResponse } from "./api.ts";
// What `.sanoma/api.ts` types the company's `api` with: a company resolves `sanoma/site`, not the runtime.
export type { CollectionApi, ListQuery, OpFn, Saved, WorkflowFn } from "@sanoma-ai/workflows/shared";
// A workflow's start form (`<RunForm workflow="hello" />`), and who is on the page.
export { RunForm } from "./form/run-form.tsx";
export { type ActorState, useActor } from "./actor.ts";
export { api } from "./queries.ts";
// A page's absolute URLs, for its canonical link and Open Graph: at the site's domain, else the request's host.
export { siteOrigin, siteUrl } from "./site-url.ts";

/**
 * The language of the page on screen: its URL's, on a page under `routes/{-$locale}/`, else its
 * site's default (the first of `defineSite({ locales })`); `"en"` on a site that has none, as its
 * `<html lang>` says. For `Intl`'s formats, say; a site's own strings are `defineMessages`'.
 */
export function useLocale(): string {
  return usePageLanguages().locale ?? "en";
}

/**
 * The page on screen in each of its site's languages, the default first: `href` the page's path
 * on this host (`/about`, `/fr/about` at the root of the site's own; under `/sites/<name>` on the
 * app's), `current` the page's own. What a language switcher links to, as the `hreflang` links
 * the app puts in the page's head do; none for a page not under `routes/{-$locale}/`.
 */
export function useLocales(): { locale: string; href: string; current: boolean }[] {
  const { locale: current, locales } = usePageLanguages();
  return locales.map(({ locale, href }) => ({ locale, href, current: locale === current }));
}

/** A site's strings in each of its languages, from `defineMessages`. */
export interface Messages<M> {
  /** The strings in `locale`: a URL's `params.locale`, in a loader or a `head`; the default's for none, or one the site lacks. */
  get(locale: string | undefined): M;
}

/** Every language of `L`, each the default's strings exactly: no key the default lacks, and no other language. */
type Translations<L extends readonly [string, ...string[]], T extends { readonly [K in L[number]]: object }> = {
  readonly [K in L[number]]: T[L[0]] & { readonly [P in Exclude<keyof T[K], keyof T[L[0]]>]: never };
} & { readonly [K in Exclude<keyof T, L[number]>]: never };

/**
 * A site's own strings in each of its languages, typed: the default language's (the first of
 * `site.locales`) say what every other has, the same keys with the same types, so a key missing
 * or extra in one, or a language missing or extra, fails the check. A string is a string; one
 * with values in it is a function of them, its parameters typed in each language.
 *
 * ```ts
 * // sites/www/messages.ts
 * import { defineMessages } from "sanoma/site";
 * import site from "./site.ts";
 *
 * export const messages = defineMessages(site, {
 *   en: { blog: "Blog", posted: (date: string) => `Posted ${date}` },
 *   fr: { blog: "Blog", posted: (date: string) => `Publié le ${date}` },
 * });
 *
 * // in a component: const t = useMessages(messages); t.posted(post.data.publishedAt)
 * ```
 */
export function defineMessages<
  const L extends readonly [string, ...string[]],
  T extends { readonly [K in L[number]]: object },
>(site: { readonly locales: L }, messages: T & Translations<L, T>): Messages<T[L[0]]> {
  const get = (locale: string | undefined): T[L[0]] =>
    messages[locale !== undefined && Object.hasOwn(messages, locale) ? (locale as L[0]) : (site.locales[0] as L[0])];
  return { get };
}

/** A site's strings (`defineMessages`) in the language of the page on screen (`useLocale`). */
export function useMessages<M>(messages: Messages<M>): M {
  return messages.get(useLocale());
}

/**
 * A site's `sites/<name>/site.ts` (optional): how the app's Sites page names it, whether it is
 * public, and in which languages. `sanoma` reads `title`, `public`, `login` and `locales` without
 * running the file.
 */
export interface SiteDefinition {
  /** The site's name on the Sites page and in its crumb; the folder's name when not given. */
  title?: string;
  /** An icon beside its title: a component that takes a `className`. */
  icon?: ComponentType<{ className?: string }>;
  /** Served at the root of its own domain to visitors, not people (a literal: read without running site.ts). */
  public?: boolean;
  /** The connector in sanoma.config.ts whose login half signs visitors in; left out, every page runs as `anonymous`. */
  login?: string;
  /**
   * A public site's languages, with no login: language tags (`"en"`, `"fr"`, `"pt-BR"`), the first
   * its default. Its pages under `routes/{-$locale}/` answer at `/…` in the default and at
   * `/<locale>/…` in each other (a literal: read without running site.ts).
   */
  locales?: readonly [string, ...string[]];
}

/**
 * A site's definition, the default export of `sites/<name>/site.ts`: `export default defineSite({ title: "Help desk" })`,
 * or for visitors `defineSite({ title: "Website", public: true, login: "auth0" })`, or in two
 * languages `defineSite({ title: "Website", public: true, locales: ["en", "fr"] })`. Its type keeps
 * the languages as written, so `defineMessages` knows them.
 */
export function defineSite<const L extends readonly [string, ...string[]] = never>(
  site: SiteDefinition & { locales?: L },
): Readonly<SiteDefinition> & ([L] extends [never] ? unknown : { readonly locales: L }) {
  return Object.freeze({ ...site }) as Readonly<SiteDefinition> &
    ([L] extends [never] ? unknown : { readonly locales: L });
}
