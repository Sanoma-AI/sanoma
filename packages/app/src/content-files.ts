// The repo's content, Node only: the Markdown files under `content/<kind>/`, their front matter
// read with `yaml` and their bodies rendered with `marked`, for the `sanoma:content` plugin
// (`build.ts`), and their types, `.sanoma/content.ts`, for the sites' tsc. Neither library
// reaches the browser: the build hands it the files as data.
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_NAME } from "@sanoma-ai/workflows/shared";
import { marked } from "marked";
import { LineCounter, parseDocument } from "yaml";
import type { ContentEntry } from "./content.ts";

/** Where `contentTypes` is written, under a company's root. */
export const CONTENT_TYPES = join(".sanoma", "content.ts");

/** What is wrong with a file or folder under `content/`, at its place. */
export interface ContentProblem {
  /** From the repo's root, with `/`. */
  file: string;
  line: number;
  column: number;
  message: string;
}

type Data = Record<string, unknown>;

const SEGMENT = "(lowercase letters, digits and dashes)";

/** The front matter: an opening `---` line through the next `---` line; group 1 is the YAML between. */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** An opening `---` line, with or without the rest. */
const OPENING = /^---[ \t]*\r?\n/;

/**
 * The repo's content: each folder directly under `content/` whose name is a URL segment is a kind,
 * and each `*.md` directly in it an entry, its slug the file's name (a URL segment too), its
 * `data` the front matter (`{}` without one), its `html` the body rendered (GFM; raw HTML kept, as
 * content is reviewed as code is). Subfolders, other files and dot-folders are left alone. A file
 * whose front matter is not closed or not a YAML mapping is left out, with a problem at its line. Without
 * `drafts`, an entry whose `draft` is `true` is left out. Entries are sorted by slug.
 */
export function readContent(
  repo: string,
  options: { drafts: boolean },
): { kinds: Record<string, ContentEntry<Data>[]>; problems: ContentProblem[] } {
  const kinds: Record<string, ContentEntry<Data>[]> = {};
  const problems: ContentProblem[] = [];
  const problem = (file: string, message: string, line = 1, column = 1) =>
    problems.push({ file, line, column, message });
  const root = join(repo, "content");
  for (const kind of folder(root, (entry) => entry.isDirectory())) {
    if (!SITE_NAME.test(kind)) {
      problem(`content/${kind}`, `a content folder's name is a URL segment ${SEGMENT}`);
      continue;
    }
    const entries: ContentEntry<Data>[] = [];
    for (const name of folder(join(root, kind), (entry) => entry.isFile() && entry.name.endsWith(".md"))) {
      const file = `content/${kind}/${name}`;
      const slug = name.slice(0, -".md".length);
      if (!SITE_NAME.test(slug)) {
        problem(file, `a content file's name is a URL segment ${SEGMENT}`);
        continue;
      }
      // A byte order mark, as some editors write one, is not the file's text.
      const text = readFileSync(join(root, kind, name), "utf8").replace(/^\uFEFF/, "");
      const front = FRONT_MATTER.exec(text);
      if (!front && OPENING.test(text)) {
        problem(file, "front matter: no closing `---` line");
        continue;
      }
      const body = front ? text.slice(front[0].length) : text;
      const lineCounter = new LineCounter();
      const doc = parseDocument(front?.[1] ?? "", { lineCounter, prettyErrors: false });
      const [error] = doc.errors;
      if (error) {
        const { line, col } = lineCounter.linePos(error.pos[0]);
        // The YAML starts on the file's second line.
        problem(file, `front matter: ${error.message}`, line + 1, col);
        continue;
      }
      const data: unknown = doc.toJS() ?? {};
      if (!isData(data)) {
        problem(file, "front matter is a mapping of names to values", 2);
        continue;
      }
      if (!options.drafts && data.draft === true) continue;
      entries.push({ slug, data, body, html: marked.parse(body, { async: false, gfm: true }) });
    }
    kinds[kind] = entries;
  }
  return { kinds, problems };
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
    else types.add(["string", "number", "boolean"].includes(typeof value) ? typeof value : "unknown");
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
