// The repo's content, Node only: the Markdown files under `content/<kind>/`, their front matter
// read with `yaml` and their bodies rendered with `marked`, for the `sanoma:content` plugin
// (`build.ts`), and their types, `.sanoma/content.ts`, for the sites' tsc. Neither library
// reaches the browser: the build hands it the files as data.
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALE, SITE_NAME } from "@sanoma-ai/workflows/shared";
import { marked } from "marked";
import { LineCounter, parseDocument } from "yaml";
import type { ContentEntry } from "./content-types.ts";

/** Where `contentTypes` is written, under a company's root. */
export const CONTENT_TYPES = join(".sanoma", "content.ts");

/**
 * Each kind's published entries (drafts left out), what a sitemap lists: each `<slug>.md` by its
 * slug, each translation by its slug and `locale`. `published.json` in a build.
 */
export type Published = Record<string, { slug: string; locale?: string }[]>;

/** The file a build writes its `Published` content to, beside `client/` and `server/`. */
export const PUBLISHED_FILE = "published.json";

/** `repo`'s published content, each kind's slugs: drafts left out. */
export const publishedOf = (repo: string): Published =>
  Object.fromEntries(
    Object.entries(readContent(repo, { drafts: false }).kinds).map(([kind, entries]) => [
      kind,
      entries.map(({ slug, locale }) => ({ slug, ...(locale !== undefined && { locale }) })),
    ]),
  );

/** What is wrong with a file or folder under `content/`, at its place. */
export interface ContentProblem {
  /** From the repo's root, with `/`. */
  file: string;
  line: number;
  column: number;
  message: string;
}

type Data = Record<string, unknown>;

const SEGMENT = "(a lowercase letter, then lowercase letters, digits and dashes)";

/** The front matter: an opening `---` line through the next `---` line; group 1 is the YAML between. */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * The repo's content: each folder directly under `content/` whose name is a URL segment is a kind,
 * and each `*.md` directly in it an entry, its slug the file's name (a URL segment too), read by
 * `parseFile`; `<slug>.<locale>.md` is the slug's translation into a language (`LOCALE`), its
 * `locale` set and its front matter laid over its `<slug>.md`'s, so a key it does not repeat (a
 * date, an image, `draft`) is the original's, as is the body when it has none. Subfolders, other files and dotfiles are left alone.
 * Without `drafts`, an entry whose `draft` is `true` is left out. Entries are sorted by slug, a slug's files by name.
 */
export function readContent(
  repo: string,
  options: { drafts: boolean },
): { kinds: Record<string, ContentEntry<Data>[]>; problems: ContentProblem[] } {
  const kinds: Record<string, ContentEntry<Data>[]> = {};
  const problems: ContentProblem[] = [];
  const root = join(repo, "content");
  for (const kind of folder(root, (entry) => entry.isDirectory())) {
    if (!SITE_NAME.test(kind)) {
      problems.push(at(`content/${kind}`, `a content folder's name is a URL segment ${SEGMENT}`));
      continue;
    }
    const entries: ContentEntry<Data>[] = [];
    for (const name of folder(join(root, kind), (entry) => entry.isFile() && entry.name.endsWith(".md"))) {
      const file = `content/${kind}/${name}`;
      const [slug = "", locale, ...rest] = name.slice(0, -".md".length).split(".");
      const read =
        SITE_NAME.test(slug) && (locale === undefined || LOCALE.test(locale)) && !rest.length
          ? parseFile(readFileSync(join(root, kind, name), "utf8"))
          : {
              message: `a content file's name is a URL segment ${SEGMENT}, then a language for a translation (\`hello.fr.md\`)`,
            };
      if ("message" in read) problems.push(at(file, read.message, read.line, read.column));
      else entries.push({ slug, ...(locale !== undefined && { locale }), ...read });
    }
    const originals = new Map(entries.filter((e) => e.locale === undefined).map((e) => [e.slug, e]));
    kinds[kind] = entries
      .map((e) => {
        const original = e.locale === undefined ? undefined : originals.get(e.slug);
        if (!original) return e;
        // A translation of its front matter alone keeps the original's body.
        const text = e.body.trim() ? { body: e.body, html: e.html } : { body: original.body, html: original.html };
        return { ...e, ...text, data: { ...original.data, ...e.data } };
      })
      .filter((e) => options.drafts || e.data.draft !== true)
      // By slug; a slug's files in name order (the sort is stable).
      .toSorted((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }
  return { kinds, problems };
}

const at = (file: string, message: string, line = 1, column = 1): ContentProblem => ({ file, line, column, message });

/**
 * A file's text as an entry: `data` the front matter (`{}` without one), `body` the rest, `html` it
 * rendered (GFM; raw HTML kept, as content is reviewed as code is). Front matter that is not
 * closed, or not a YAML mapping, is a problem at its line instead.
 */
function parseFile(
  text: string,
): Omit<ContentEntry<Data>, "slug"> | { message: string; line?: number; column?: number } {
  // A byte order mark, as some editors write one, is not the file's text.
  const unmarked = text.replace(/^\uFEFF/, "");
  const front = FRONT_MATTER.exec(unmarked);
  if (!front && /^---[ \t]*\r?\n/.test(unmarked)) return { message: "front matter: no closing `---` line" };
  const lineCounter = new LineCounter();
  const doc = parseDocument(front?.[1] ?? "", { lineCounter, prettyErrors: false });
  const [error] = doc.errors;
  if (error) {
    const { line, col } = lineCounter.linePos(error.pos[0]);
    // The YAML starts on the file's second line.
    return { message: `front matter: ${error.message}`, line: line + 1, column: col };
  }
  let data: unknown;
  try {
    data = doc.toJS() ?? {};
  } catch (err) {
    // Too many aliases, say.
    return { message: `front matter: ${err instanceof Error ? err.message : String(err)}`, line: 2 };
  }
  if (!isData(data)) return { message: "front matter is a mapping of names to values", line: 2 };
  const body = front ? unmarked.slice(front[0].length) : unmarked;
  return { data, body, html: marked.parse(body, { async: false, gfm: true }) };
}

/** The names of `dir`'s entries that `keep` keeps, dotfiles aside (an editor's `.obsidian/`), sorted; none when it does not exist. */
function folder(dir: string, keep: (entry: Dirent) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && keep(entry))
    .map((entry) => entry.name)
    .toSorted();
}

const isData = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `.sanoma/content.ts` for `readContent`'s kinds: `content.<kind>` as a `ContentKind` of the
 * front matter its files hold, a key in every file required and `?` otherwise, augmenting
 * `sanoma/site`'s `Register`. Only the shapes the files have, never their values: `status: draft`
 * is a `string`. Pure: the same kinds give the same text.
 */
export function contentTypes(kinds: Record<string, ContentEntry<Data>[]>): string {
  const members = Object.entries(kinds).map(([kind, entries]) => {
    const count = `${entries.length} file${entries.length === 1 ? "" : "s"}`;
    return `  /** content/${kind}: ${count}. */\n  ${key(kind)}: ContentKind<${objectType(entries.map((e) => e.data))}>;`;
  });
  return [
    "// Generated by sanoma from content/; do not edit.",
    'import type { ContentKind } from "sanoma/site";',
    "",
    members.length ? `interface CompanyContent {\n${members.join("\n")}\n}` : "interface CompanyContent {}",
    "",
    'declare module "sanoma/site" {',
    "  interface Register {",
    "    content: CompanyContent;",
    "  }",
    "}",
    "",
    "export {};",
    "",
  ].join("\n");
}

/** The type of every value in `values`, one alternative each kind of value: objects merged into one, and arrays. */
function alternatives(values: unknown[]): string[] {
  const types = new Set<string>();
  const arrays: unknown[][] = [];
  const objects: Data[] = [];
  for (const value of values) {
    if (value === null) types.add("null");
    else if (Array.isArray(value)) arrays.push(value);
    else if (isData(value)) objects.push(value);
    // A string, a number or a boolean: YAML's core schema has nothing else.
    else types.add(typeof value);
  }
  if (arrays.length) {
    const items = alternatives(arrays.flat());
    types.add(items.length === 0 ? "unknown[]" : items.length === 1 ? `${items[0]}[]` : `(${items.join(" | ")})[]`);
  }
  if (objects.length) types.add(objectType(objects));
  return [...types];
}

/** The objects as one type: each key that any has, `?` unless every one has it, in the order they first appear. */
function objectType(objects: Data[]): string {
  const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))];
  if (!keys.length) return "{}";
  const props = keys.map((name) => {
    const having = objects.filter((object) => Object.hasOwn(object, name));
    const optional = having.length < objects.length ? "?" : "";
    return `${key(name)}${optional}: ${alternatives(having.map((object) => object[name])).join(" | ")}`;
  });
  return `{ ${props.join("; ")} }`;
}

/** A property's name, quoted when it is not an identifier. */
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
