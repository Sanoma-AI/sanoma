import { defineConnector } from "@sanoma/workflows";
import { z } from "zod";

const Post = z.object({
  id: z.string(),
  url: z.string(),
  slug: z.string(),
  status: z.enum(["draft", "scheduled", "published"]),
  publishedAt: z.string().nullable(),
});

/** Ghost Admin API: https://ghost.org/docs/admin-api/ */
export const ghost = defineConnector("ghost", {
  post: {
    create: {
      effect: "write",
      description: "Create a post. Drafts are not visible on the site.",
      input: z.object({ title: z.string().min(1), html: z.string(), status: z.literal("draft").default("draft") }),
      output: Post,
    },
    publish: {
      effect: "publish",
      description: "Publish a draft post on the site. Visible to everyone.",
      idempotent: true,
      input: z.object({ id: z.string() }),
      output: Post,
    },
  },
});
