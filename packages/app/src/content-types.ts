// The shapes of a site's `content` (`content.ts`), in a file of their own that imports nothing, so
// the Node side that reads the files (`content-files.ts`) shares them without the browser module.

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
