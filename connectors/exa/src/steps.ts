import { defineSteps } from "@sanoma-ai/workflows";
import { exaOps } from "./connector.ts";

const { search, answer } = exaOps.web;

/**
 * Exa's steps for Gherkin tests: Exa failing the next search, and a search or a question the run
 * made, by some of its query.
 */
export const exaSteps = defineSteps("exa", ({ given, then }) => {
  given("Exa fails to search once", () => ({ op: search, fault: "failNext" }));
  then("Exa was searched for {string}", (text: string) => ({
    op: search,
    called: true,
    check: (run) => {
      const queries = run.calls(search).map((c) => c.input.query);
      if (queries.some((q) => q.includes(text))) return undefined;
      return queries.length
        ? `no Exa search was for "${text}"; the searches were ${JSON.stringify(queries)}`
        : "Exa was not searched";
    },
  }));
  then("Exa was asked {string}", (text: string) => ({
    op: answer,
    called: true,
    check: (run) => {
      const queries = run.calls(answer).map((c) => c.input.query);
      if (queries.some((q) => q.includes(text))) return undefined;
      return queries.length
        ? `Exa was not asked "${text}"; it was asked ${JSON.stringify(queries)}`
        : "Exa was asked nothing";
    },
  }));
});
