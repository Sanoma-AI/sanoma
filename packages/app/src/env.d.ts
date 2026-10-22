// The app's ambient types, for a tsconfig outside the package (a company's generated
// .sanoma/app/tsconfig.json): resolved from here, where vite and @types/node are dependencies.
/// <reference types="vite/client" />
/// <reference types="node" />

/** The repo's content, by kind, as the `sanoma:content` plugin reads it (`readContent`): `content.ts` imports it. */
declare module "virtual:sanoma/content" {
  const kinds: Record<string, import("./content.ts").ContentEntry<Record<string, unknown>>[]>;
  export default kinds;
}
