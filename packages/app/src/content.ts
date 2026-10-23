import type { Register } from "./api-client.ts";
import type { ContentEntry, ContentKind } from "./content-types.ts";

export type { ContentEntry, ContentKind, ContentOptions, ContentSummary } from "./content-types.ts";

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

/** A kind's entries; none for a kind with no folder (`constructor` among them: only the module's own keys). */
const entriesOf = async (kind: string) => {
  const all = await kinds();
  return Object.hasOwn(all, kind) ? all[kind]! : [];
};

/**
 * A kind's entries in `locale`: each slug's `<slug>.<locale>.md`, else its `<slug>.md`; without
 * one, the `<slug>.md` files alone. Sorted by slug, as the build read them.
 */
async function inLocale(kind: string, locale: string | undefined): Promise<ContentEntry<unknown>[]> {
  const entries = await entriesOf(kind);
  const picked = new Map<string, ContentEntry<unknown>>();
  for (const entry of entries) {
    if (entry.locale === undefined ? !picked.has(entry.slug) : entry.locale === locale) picked.set(entry.slug, entry);
  }
  return [...picked.values()];
}

/**
 * The repo's content, `content.<kind>.list()` and `.get(slug)`, each in a language given
 * `{ locale }`: a kind with no folder has no files. Drafts (`draft: true`) are there while
 * `sanoma` serves the sites from its dev server, never in a build.
 */
export const content = new Proxy(
  {},
  {
    // A kind is an object, never a function, so `content` is no thenable even with a `content/then/`.
    get: (_, kind): ContentKind<unknown> | undefined =>
      typeof kind !== "string"
        ? undefined
        : {
            list: async (options) =>
              (await inLocale(kind, options?.locale)).map(({ slug, locale, data }) =>
                locale === undefined ? { slug, data } : { slug, locale, data },
              ),
            get: async (slug, options) => {
              const entries = (await entriesOf(kind)).filter((entry) => entry.slug === slug);
              const locale = options?.locale;
              return (
                (locale !== undefined && entries.find((entry) => entry.locale === locale)) ||
                entries.find((entry) => entry.locale === undefined)
              );
            },
          },
  },
) as Content;
