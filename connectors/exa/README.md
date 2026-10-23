# @sanoma-ai/connector-exa

[Exa](https://exa.ai) web search operations for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): a search, pages read by URL, the pages like one, and an answer with its sources.

## Usage

```sh
npm install @sanoma-ai/connector-exa
```

| Operation             | Effect | What it does                                                                                 |
| --------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `exa.web.search`      | `read` | Search the web, and return the pages found, with their text, highlights or summary if asked. |
| `exa.web.getContents` | `read` | Read pages by URL: their text, highlights or summary.                                        |
| `exa.web.findSimilar` | `read` | Find pages like the one at a URL.                                                            |
| `exa.web.answer`      | `read` | Answer a question from a web search, with the pages the answer cites.                        |

```ts
import { exa } from "@sanoma-ai/connector-exa";
import { defineWorkflow } from "@sanoma-ai/workflows";

defineWorkflow({
  // ...
  uses: [exa.web.search, exa.web.answer],
  run: async (ctx, input) => {
    const { results } = await ctx.exa.web.search({
      query: `${input.company} pricing page`,
      numResults: 5,
      contents: { highlights: { query: "price per month" } },
    });
    const { answer, citations } = await ctx.exa.web.answer({ query: `What does ${input.company} charge?` });
    return { pages: results.map((r) => r.url), answer, sources: citations.map((c) => c.url) };
  },
});
```

The inputs are Exa's own fields ([API reference](https://exa.ai/docs/reference/search)), cut to these:

- `search`: `query`, `type` (`auto` by default, `neural`, or `lite`, the cheapest, in beta), `category` (`company`, `publication`, `news`, `personal site`, `financial report`, `people`), and the filters below.
- `findSimilar`: `url`, `excludeSourceDomain`, and the filters below. `exa-js` marks it deprecated, with no other way to find pages like one; Exa's endpoint still answers.
- The filters: `numResults` (1 to 100, 10 by default), `includeDomains`, `excludeDomains`, `startPublishedDate` and `endPublishedDate` (ISO 8601), and `contents`, what of each page to return.
- `getContents`: `urls`, and what `contents` takes, at the top level: `text` (`true`, or `{ maxCharacters }`), `highlights` (`true`, or `{ maxCharacters, query }`), `summary` (`{ query? }`) and `maxAgeHours` (the oldest cached copy to use; 0 fetches the page again, -1 never does).
- `answer`: `query`, and `text` to return each cited page's text.

Each page comes back as `{ id, url, title, author, publishedDate, score, image?, favicon? }` plus the `text`, `highlights` and `summary` asked for. `getContents` returns `statuses` too, one per URL: a page Exa could not read is not in `results` but in `statuses` with `status: "error"` and an `error.tag` such as `CRAWL_NOT_FOUND`, and the call itself succeeds.

The logo the app shows beside these operations is Exa's mark from its [brand page](https://exa.ai/brand), blue or white. It is there only to identify the service an operation calls. Exa Labs, which makes Exa, does not endorse this package.

## Driver

`@sanoma-ai/connector-exa/driver` calls Exa. The `exa` connector the package root exports carries it, made once per resolved config, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that):

```ts
import { exa } from "@sanoma-ai/connector-exa";

export default defineConfig({ workflows, connectors: [exa], policy });
```

`./driver` (`exaDriver`; `exaDriver({ timeoutMs })`, 30 s by default, since an answer takes several seconds) and `./fake` (`fakeExa`) are internal entries, for tests.

It calls Exa through [`exa-js`](https://www.npmjs.com/package/exa-js), Exa's own SDK, loaded at the first call (it brings the OpenAI SDK and zod 3 with it). A search with no `contents` asks for none, where the SDK would ask for each page's text.

### Environment

It reads this on every call, never when the config loads:

| Variable      | What it is                                                                             |
| ------------- | -------------------------------------------------------------------------------------- |
| `EXA_API_KEY` | An Exa API key, from the API Keys page of [Exa's dashboard](https://dashboard.exa.ai). |

When it is unset, a call fails, not retryable, naming it. The driver declares it in its `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)): the worker starts without it, warning, and the app's connector page shows its status and lets you set it.

### Errors and retries

Every operation only reads, so a retried call changes nothing, though each call costs Exa credits. A 408, a 429 (rate limit), a 5xx (Exa overloaded, `SERVICE_OVERLOADED`, or a request past its deadline), a timeout (30 s; `timeoutMs` changes it) or no reply is retryable; any other 4xx is not, such as 401 `INVALID_API_KEY` and 402 `NO_MORE_CREDITS` or a budget spent. `status` is kept, and Exa's message ([error codes](https://exa.ai/docs/reference/error-codes)); `exa-js` drops the error's `tag`, so `vendorCode` is set only when its error carries a `code`. A reply with no body, or an answer that is not text, fails for good.

### Testing the driver

`test/driver.test.ts` replays Exa's replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api), which says what `SANOMA_LIVE` and `SANOMA_RECORD` do: `pnpm vitest run connectors/exa` needs no account. The fixtures were written from Exa's API reference and error docs, not recorded from its API; live, the tests search Exa and spend a few cents of credits, and recording replaces them with Exa's own replies:

```sh
SANOMA_LIVE=1 SANOMA_RECORD=1 EXA_API_KEY=... pnpm vitest run connectors/exa
```

A recording loses request ids. The error cases only replay.

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`exaSteps`, attached with `withSetup`), which a company's scenario can use beside the generic steps and other connectors' ones:

| Keyword | Step                            | What it does                                                   |
| ------- | ------------------------------- | -------------------------------------------------------------- |
| Given   | `Exa fails to search once`      | The next `exa.web.search` fails (`failNext`)                   |
| Then    | `Exa was searched for {string}` | The run searched Exa with a query that holds that text         |
| Then    | `Exa was asked {string}`        | The run asked `exa.web.answer` a question that holds that text |

`features/search.feature`, `features/contents.feature` and `features/answer.feature` test each operation with these steps and the generic ones for an operation's own test, on the fake and on Exa's replies: `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). A scenario tagged `@fake-only` has no recording. The package ships `features/`.

## Testing

`@sanoma-ai/connector-exa/fake` is an in-memory Exa that searches nothing, the fake the connector carries: each sandbox run makes one of its own. It makes up to three pages for a query or a URL, from them alone, so one call always finds the same pages (on the first of `includeDomains`, else `example.com`, or for `findSimilar` the URL's own host, and never on a domain excluded), with the `text`, `highlights` and `summary` asked for. The pages it served stay in `state.pages`, by URL, which `getContents` reads; put a page there to give it a text of your own. `getContents` returns each page's text when the call asks for none of text, highlights or summary, as Exa does. A URL on a `.invalid` host cannot be read: `getContents` returns it in `statuses` as `CRAWL_NOT_FOUND`.

```ts
import { withSetup } from "@sanoma-ai/workflows";
import { exa } from "@sanoma-ai/connector-exa";
import { fakeExa } from "@sanoma-ai/connector-exa/fake";

const fake = fakeExa();
fake.update((state) => {
  state.pages["https://acme.example/pricing"] = {
    url: "https://acme.example/pricing",
    title: "Pricing",
    text: "$20 a month.",
  };
});
const worker = await startWorker({
  connectors: [withSetup(exa, { driver: () => fake.driver, fake: () => fake })],
  /* ... */
});

// ...run a workflow, then:
fake.calls.map((c) => c.op); // ["exa.web.search", "exa.web.getContents"]
```

To test what a workflow does when Exa misbehaves, set up the next call to an operation before the run makes it: `fake.failNext("exa.web.search", err?)`, `fake.rateLimit("exa.web.search")` (a `DriverError` with status 429), `fake.loseReply(…)` and `fake.hold(…)`. `fake.reset()` empties it between tests.

[`@sanoma-ai/testing`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md) (in the sanoma repository, not published) has `startTestWorker` and `testDatabaseUrl` to run a test's worker with the fake on a database of its own.

License: FSL-1.1-ALv2.
