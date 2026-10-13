import { defineSteps } from "@sanoma/workflows";
import { ghostOps } from "./connector.ts";

const { create, publish } = ghostOps.post;

/**
 * Ghost's steps for Gherkin tests: a draft on the blog before the run (named `draft`, so an
 * operation's own test can use `$draft.id`), and a post the run published, found by its title
 * among the drafts seeded and created.
 */
export const ghostSteps = defineSteps("ghost", ({ given, then }) => {
  given("a Ghost draft titled {string}", (title: string) => ({ op: create, input: { title }, as: "draft" }));
  then("the Ghost post {string} is published", (title: string) => ({
    op: publish,
    called: true,
    check: (run) => {
      const ids = run
        .made(create)
        .filter((c) => c.input.title === title)
        .map((c) => c.output.id);
      if (ids.length === 0) return `no Ghost post titled "${title}" was drafted`;
      if (run.calls(publish).some((c) => ids.includes(c.input.id))) return undefined;
      return `the Ghost post "${title}" (${ids.join(", ")}) was not published`;
    },
  }));
});
