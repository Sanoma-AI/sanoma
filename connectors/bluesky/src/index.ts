import { defineConnector } from "@sanoma/workflows";
import { z } from "zod";

/** Bluesky via the AT Protocol: https://docs.bsky.app/docs/advanced-guides/posts */
export const bluesky = defineConnector("bluesky", {
  post: {
    create: {
      effect: "publish",
      description: "Post publicly to the account's feed.",
      input: z.object({ text: z.string().min(1).max(300) }),
      output: z.object({ uri: z.string(), cid: z.string(), url: z.string() }),
    },
  },
});
