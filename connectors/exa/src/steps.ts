import { defineSteps, type Expect, type Op } from "@sanoma-ai/workflows";
import { exaOps } from "./connector.ts";

const { search, answer } = exaOps.web;

/** A `then` that the run called `op` with a query holding `text`, and what it says when not. */
const queried = (
  op: Op<"exa", "web", string, { query: string }>,
  text: string,
  miss: string,
  none: string,
): Expect => ({
  op,
  called: true,
  check: (run) => {
    const queries = run.calls(op).map((c) => c.input.query);
    if (queries.some((q) => q.includes(text))) return undefined;
    return queries.length ? `${miss}; the queries were ${JSON.stringify(queries)}` : none;
  },
});

/**
 * Exa's steps for Gherkin tests: Exa failing the next search, and a search or a question the run
 * made, by some of its query.
 */
export const exaSteps = defineSteps("exa", ({ given, then }) => {
  given("Exa fails to search once", () => ({ op: search, fault: "failNext" }));
  then("Exa was searched for {string}", (text: string) =>
    queried(search, text, `no Exa search was for "${text}"`, "Exa was not searched"),
  );
  then("Exa was asked {string}", (text: string) =>
    queried(answer, text, `Exa was not asked "${text}"`, "Exa was asked nothing"),
  );
});
