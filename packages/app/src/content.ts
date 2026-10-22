// oxlint-disable-next-line typescript/triple-slash-reference -- the Node build compiles this file too (content-files.ts imports its types), and env.d.ts, which declares virtual:sanoma/content, is not in that program
/// <reference path="./env.d.ts" />
import type { Register } from "./api-client.ts";

// A site's `content`, from `sanoma/site`: the Markdown files under the repo's `content/`, as the
// build read them (`readContent` in `content-files.ts`, through the `sanoma:content` plugin's
// virtual module). The module is imported on the first call, so content is a chunk of its own and
// no page's chunk holds it. Browser code; the types come from the company's generated
// `.sanoma/content.ts`, which augments `Register` as `.sanoma/api.ts` does.

/** A file under `content/<kind>/`, as `list()` gives it: its name and its front matter. */
export interface ContentSummary<D> {
  /** The file's name without `.md`. */
  slug: string;
  /** The front matter: `{}` when the file has none. */
  data: D;
}

/** A file under `content/<kind>/`, as `get(slug)` gives it. */
export interface ContentEntry<D> extends ContentSummary<D> {
  /** The Markdown after the front matter, as written. */
  body: string;
  /** `body` rendered at build (GFM), for `dangerouslySetInnerHTML`. */
  html: string;
}

/** One kind of content, `content/<kind>/*.md`. */
export interface ContentKind<D> {
  /** Every file's slug and front matter, sorted by slug. */
  list(): Promise<ContentSummary<D>[]>;
  /** One file, with its body; `undefined` when there is no such file. */
  get(slug: string): Promise<ContentEntry<D> | undefined>;
}

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
