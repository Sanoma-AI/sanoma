import { defineFake, type FakeOptions } from "@sanoma-ai/workflows/fake";
import type { z } from "zod";
import { exaOps } from "./connector.ts";

/** A page of the fake web. */
export interface FakeExaPage {
  url: string;
  title: string;
  text: string;
}

export interface FakeExaState extends Record<string, unknown> {
  /** The pages the fake has served, by URL; a test may put its own here for `getContents` to read. */
  pages: Record<string, FakeExaPage>;
}

type Contents = z.infer<typeof exaOps.web.getContents.input>;

/** How many results the fake returns at most, whatever `numResults` asks. */
const MAX_RESULTS = 3;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "") || "page";

/** Where the fake's pages are: the first domain the filters include, else `usual` unless they exclude it. */
const hostFor = (usual: string, filters: { includeDomains?: string[]; excludeDomains?: string[] }) =>
  filters.includeDomains?.[0] ?? (filters.excludeDomains?.includes(usual) ? `other.${usual}.example` : usual);

/** A page as Exa returns it, with what of it `contents` asks for. */
function shown(page: FakeExaPage, contents: Omit<Contents, "urls"> = {}, score?: number) {
  const { text, highlights, summary } = contents;
  const max = (option: typeof text | typeof highlights) =>
    typeof option === "object" ? option.maxCharacters : undefined;
  return {
    id: page.url,
    url: page.url,
    title: page.title,
    author: null,
    publishedDate: null,
    ...(score === undefined ? {} : { score }),
    ...(text ? { text: page.text.slice(0, max(text)) } : {}),
    ...(highlights ? { highlights: [page.text.split(". ")[0]!.slice(0, max(highlights))] } : {}),
    ...(summary ? { summary: `A summary of ${page.title}${summary.query ? `, for "${summary.query}"` : ""}.` } : {}),
  };
}

/**
 * An in-memory Exa for tests: it searches nothing, and makes up up to three pages for a query or
 * a URL, from them alone, so the same call always finds the same pages. A page it served stays in
 * `state.pages`, which `getContents` reads; a URL on a `.invalid` host cannot be read
 * (`CRAWL_NOT_FOUND`), as on the web.
 */
export function fakeExa(options: FakeOptions = {}) {
  return defineFake(
    exaOps,
    {
      initial: (): FakeExaState => ({ pages: {} }),
      ops: (state) => {
        /** The page at a URL: one the fake served or was given, else one made up from the URL. */
        const page = (url: string, title = url): FakeExaPage =>
          (state.pages[url] ??= { url, title, text: `${title}. A page of the fake web, at ${url}.` });
        /** Up to `n` pages under `base`, the first the closest. */
        const found = (base: string, title: (i: number) => string, n = 10, contents?: Contents) =>
          Array.from({ length: Math.min(n, MAX_RESULTS) }, (_, i) =>
            shown(page(`${base}-${i + 1}`, title(i + 1)), contents, 1 - i / 10),
          );
        return {
          web: {
            search: async ({ query, numResults, contents, ...filters }) => ({
              results: found(
                `https://${hostFor("example.com", filters)}/${slug(query)}`,
                (i) => `${query} (${i})`,
                numResults,
                contents,
              ),
            }),
            findSimilar: async ({ url, numResults, excludeSourceDomain, contents, ...filters }) => {
              const { hostname, pathname } = new URL(url);
              const excluded = excludeSourceDomain ? [hostname] : [];
              const host = hostFor(hostname, {
                ...filters,
                excludeDomains: [...excluded, ...(filters.excludeDomains ?? [])],
              });
              return {
                results: found(
                  `https://${host}/like-${slug(pathname)}`,
                  (i) => `Like ${url} (${i})`,
                  numResults,
                  contents,
                ),
              };
            },
            getContents: async ({ urls, ...contents }) => {
              const readable = urls.filter((url) => !URL.parse(url)?.hostname.endsWith(".invalid"));
              return {
                results: readable.map((url) => shown(page(url), contents)),
                statuses: urls.map((id) =>
                  readable.includes(id)
                    ? { id, status: "success" as const }
                    : { id, status: "error" as const, error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
                ),
              };
            },
            answer: async ({ query, text }) => {
              const source = page(`https://example.com/${slug(query)}-1`, `${query} (1)`);
              return {
                answer: `A made-up answer to "${query}", from ${source.url}.`,
                citations: [shown(source, { text })],
              };
            },
          },
        };
      },
    },
    options,
  );
}
