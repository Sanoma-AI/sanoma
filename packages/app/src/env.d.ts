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
 * whose entries are one's, by path, and every site's key (`siteKey`), as the `sanoma:locales`
 * plugin reads them (`siteLocales`, `siteContentPages`, `sitesUnder`).
 */
declare module "virtual:sanoma/locales" {
  const locales: Record<string, string[]>;
  export default locales;
  export const contentPages: Record<string, string>;
  export const sites: string[];
}
