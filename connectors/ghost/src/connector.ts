import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/** A post, as the operations return it. */
export const Post = z.object({
  id: z.string(),
  url: z.string(),
  slug: z.string(),
  /** `sent`: emailed to a newsletter only, never on the site. */
  status: z.enum(["draft", "scheduled", "published", "sent"]),
  publishedAt: z.string().nullable(),
});

/** Ghost Admin API: https://ghost.org/docs/admin-api/ */
export const ghostOps = defineConnector(
  "ghost",
  {
    post: {
      create: {
        effect: "write",
        description: "Create a post. Drafts are not visible on the site.",
        phrases: { given: "a post titled {title} exists", expect: "a post titled {title} is created" },
        input: z.object({ title: z.string().min(1), html: z.string(), status: z.literal("draft").default("draft") }),
        output: Post,
      },
      publish: {
        effect: "publish",
        description: "Publish a draft post on the site. Visible to everyone.",
        phrases: { expect: "post {id} is published" },
        idempotent: true,
        input: z.object({ id: z.string() }),
        output: Post,
      },
    },
  },
  vendorInfo(import.meta.url),
);
