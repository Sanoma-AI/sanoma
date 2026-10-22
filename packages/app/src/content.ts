import type { Register } from "./api-client.ts";
import type { ContentKind } from "./content-types.ts";

export type { ContentEntry, ContentKind, ContentSummary } from "./content-types.ts";

// A site's `content`, from `sanoma/site`: the Markdown files under the repo's `content/`, as the
// build read them (`readContent` in `content-files.ts`, through the `sanoma:content` plugin's
// virtual module). The module is imported on the first call, so content is a chunk of its own and
// no page's chunk holds it. Browser code; the types come from the company's generated
// `.sanoma/content.ts`, which augments `Register` as `.sanoma/api.ts` does.

/** `content` before `.sanoma/content.ts` types it: any kind. */
// oxlint-disable-next-line typescript/no-explicit-any -- untyped until .sanoma/content.ts
export type UntypedContent = any;

/** The company's content, as `.sanoma/content.ts` declares it in `Register`; `UntypedContent` without one. */
export type Content = Register extends { content: infer C } ? C : UntypedContent;

/** The kinds, by name: the module's own cache holds them once imported. */
const kinds = async () => (await import("virtual:sanoma/content")).default;

/**
 * The repo's content, `content.<kind>.list()` and `.get(slug)`: a kind with no folder has no files.
 * Drafts (`draft: true`) are there while `sanoma` serves the sites from its dev server, never in a build.
 */
export const content = new Proxy(
  {},
  {
    // A kind is an object, never a function, so `content` is no thenable even with a `content/then/`.
    get: (_, kind): ContentKind<unknown> | undefined =>
      typeof kind !== "string"
        ? undefined
        : {
            list: async () => ((await kinds())[kind] ?? []).map(({ slug, data }) => ({ slug, data })),
            get: async (slug) => (await kinds())[kind]?.find((entry) => entry.slug === slug),
          },
  },
) as Content;
