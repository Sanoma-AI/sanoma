import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/** What of each page to return with it; none of them by default. Exa's `ContentsRequest`, cut. */
const contents = {
  text: z
    .union([z.literal(true), z.object({ maxCharacters: z.int().positive().optional() })])
    .optional()
    .describe("The page's text, all of it or up to `maxCharacters`"),
  highlights: z
    .union([
      z.literal(true),
      z.object({ maxCharacters: z.int().positive().optional(), query: z.string().min(1).optional() }),
    ])
    .optional()
    .describe("The passages of the page most relevant to the query, or to `query`"),
  summary: z
    .object({ query: z.string().min(1).optional() })
    .optional()
    .describe("A summary of the page, written for `query` when given"),
  maxAgeHours: z
    .int()
    .min(-1)
    .optional()
    .describe("The oldest cached copy to use, in hours, else Exa fetches the page again: 0 always, -1 never"),
};

/** The filters a search and a similar-page search share. Dates are ISO 8601, such as `2025-01-31`. */
const filters = {
  numResults: z.int().min(1).max(100).optional().describe("How many results, 10 by default"),
  includeDomains: z.array(z.string().min(1)).optional().describe("Only results from these domains"),
  excludeDomains: z.array(z.string().min(1)).optional().describe("No results from these domains"),
  startPublishedDate: z.string().min(1).optional().describe("Only pages published after this date"),
  endPublishedDate: z.string().min(1).optional().describe("Only pages published before this date"),
  contents: z.object(contents).optional().describe("What of each page to return with it"),
};

/** A page Exa found, with what of it the call asked for. */
const result = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullish(),
  author: z.string().nullish(),
  publishedDate: z.string().nullish(),
  /** How close the page is to the query or URL, from 0 to 1. */
  score: z.number().nullish(),
  image: z.string().optional(),
  favicon: z.string().optional(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

const results = z.object({ results: z.array(result) });

/**
 * Exa, the web search API (https://exa.ai/docs/reference): a search, a page's contents, the pages
 * like one, and an answer with its sources. Every operation reads; each call costs Exa credits.
 */
export const exaOps = defineConnector(
  "exa",
  {
    web: {
      search: {
        effect: "read",
        idempotent: true,
        description: "Search the web, and return the pages found, with their text, highlights or summary if asked.",
        input: z.object({
          query: z.string().min(1),
          type: z
            .enum(["auto", "neural", "fast", "instant", "deep-lite", "deep", "deep-reasoning"])
            .optional()
            .describe("How Exa searches: `auto` by default"),
          category: z
            .enum(["company", "publication", "news", "personal site", "financial report", "people"])
            .optional()
            .describe("The kind of page to look for"),
          ...filters,
        }),
        output: results,
      },
      getContents: {
        effect: "read",
        idempotent: true,
        description: "Read pages by URL: their text, highlights or summary.",
        input: z.object({ urls: z.array(z.url()).min(1), ...contents }),
        output: results.extend({
          /** Each URL's fetch: a page that could not be read is in here with an `error`, not in `results`. */
          statuses: z.array(
            z.object({
              id: z.string(),
              /** `success`, or `error` with Exa's `tag`, such as `CRAWL_NOT_FOUND`. */
              status: z.string(),
              error: z.object({ tag: z.string().optional(), httpStatusCode: z.number().nullish() }).nullish(),
            }),
          ),
        }),
      },
      findSimilar: {
        effect: "read",
        idempotent: true,
        description: "Find pages like the one at a URL.",
        input: z.object({
          url: z.url(),
          excludeSourceDomain: z.boolean().optional().describe("No results from the URL's own domain"),
          ...filters,
        }),
        output: results,
      },
      answer: {
        effect: "read",
        idempotent: true,
        description: "Answer a question from a web search, with the pages the answer cites.",
        input: z.object({
          query: z.string().min(1),
          text: z.boolean().optional().describe("Return each cited page's text too"),
        }),
        output: z.object({ answer: z.string(), citations: z.array(result) }),
      },
    },
  },
  vendorInfo(import.meta.url),
);
