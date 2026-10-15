import { defineSteps } from "@sanoma-ai/workflows";
import { blueskyOps } from "./connector.ts";

const { create } = blueskyOps.post;

/** Bluesky's steps for Gherkin tests: Bluesky failing the next post, and a post the run made, by some of its text. */
export const blueskySteps = defineSteps("bluesky", ({ given, then }) => {
  given("Bluesky fails to post once", () => ({ op: create, fault: "failNext" }));
  then("Bluesky has a post with {string}", (text: string) => ({
    op: create,
    called: true,
    check: (run) => {
      const posts = run.calls(create).map((c) => c.input.text);
      if (posts.some((p) => p.includes(text))) return undefined;
      return posts.length
        ? `no Bluesky post has "${text}"; the posts were ${JSON.stringify(posts)}`
        : "nothing was posted to Bluesky";
    },
  }));
});
