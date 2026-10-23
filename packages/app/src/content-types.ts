// The shapes of a site's `content` (`content.ts`), in a file of their own that imports nothing, so
// the Node side that reads the files (`content-files.ts`) shares them without the browser module.

/** A file under `content/<kind>/`, as `list()` gives it: its name and its front matter. */
export interface ContentSummary<D> {
  /** The file's name without `.md` (and without its language). */
  slug: string;
  /** The language of a translation, `<slug>.<locale>.md`; absent for `<slug>.md`, the site's default's. */
  locale?: string;
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

/**
 * Which language to read: `locale` (a page's `params.locale`), each slug's translation into it,
 * `<slug>.<locale>.md`, else `<slug>.md`; without one, `<slug>.md` alone.
 */
export interface ContentOptions {
  locale?: string | undefined;
}

/** One kind of content, `content/<kind>/*.md`. */
export interface ContentKind<D> {
  /** Every slug's file, as `ContentOptions` picks it, with its front matter, sorted by slug. */
  list(options?: ContentOptions): Promise<ContentSummary<D>[]>;
  /** One slug's file, as `ContentOptions` picks it, with its body; `undefined` when there is no such file. */
  get(slug: string, options?: ContentOptions): Promise<ContentEntry<D> | undefined>;
}
