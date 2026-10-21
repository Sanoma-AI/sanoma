import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/** Bluesky via the AT Protocol: https://docs.bsky.app/docs/advanced-guides/posts */
export const blueskyOps = defineConnector(
  "bluesky",
  {
    post: {
      create: {
        effect: "publish",
        description: "Post publicly to the account's feed.",
        phrases: { expect: "{text} is posted to Bluesky" },
        // The driver names the post's record after the idempotency key, and the fake dedupes on it.
        idempotent: true,
        input: z.object({ text: z.string().min(1).max(300) }),
        output: z.object({ uri: z.string(), cid: z.string(), url: z.string() }),
      },
    },
  },
  vendorInfo(import.meta.url),
);
