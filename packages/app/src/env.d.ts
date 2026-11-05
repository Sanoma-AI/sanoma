// The app's ambient types, for a tsconfig outside the package (a company's generated
// .sanoma/app/tsconfig.json): resolved from here, where vite and @types/node are dependencies.
/// <reference types="vite/client" />
/// <reference types="node" />

/** The repo's content, by kind, as the `sanoma:content` plugin reads it (`readContent`): `content.ts` imports it. */
declare module "virtual:sanoma/content" {
  const kinds: Record<string, import("./content-types.ts").ContentEntry<Record<string, unknown>>[]>;
  export default kinds;
}

/**
 * Each public site's languages, by name, the first its default, the content kind of each page
 * whose entries are one's, by path, and every site's key (`siteKey`), as the `sanoma:sites`
 * plugin reads them (`siteLocales`, `siteContentPages`, `sitesUnder`).
 */
declare module "virtual:sanoma/locales" {
  const locales: Record<string, string[]>;
  export default locales;
  export const contentPages: Record<string, string>;
  export const sites: string[];
}

/** The Lucide icons the sites' `site.ts` name, by name, as the `sanoma:sites` plugin reads them (`siteIcons`): `SiteIcon` imports it. */
declare module "virtual:sanoma/icons" {
  const icons: ReadonlyMap<string, import("lucide-react").LucideIcon>;
  export default icons;
}

/**
 * The app bundle's company, as the Worker's build makes it (`bundleModule` in `bundle-build.ts`):
 * its config and root, the snapshot of its files, and Cedar's web build, initialised on first use.
 */
declare module "virtual:sanoma/app-root" {
  export const root: string;
  export const snapshot: import("./snapshot.ts").AppSnapshot;
}

declare module "virtual:sanoma/app-bundle" {
  export const config: import("@sanoma-ai/workflows").SanomaConfig;
  export const cedar: () => import("@sanoma-ai/workflows").CedarWasm;
  export const TimeMatcher: import("@sanoma-ai/workflows").TimeMatcherClass;
}
