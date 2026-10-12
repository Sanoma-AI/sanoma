import { defineConnector } from "@sanoma/workflows";
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

/**
 * Ghost's glyph, from simple-icons (https://simpleicons.org/?q=ghost, CC0; drawn from Ghost's
 * own admin icon), in one colour: Ghost's near-black, white on dark backgrounds. Ghost publishes
 * no SVG of its own.
 */
const glyph = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm.256 2.313c2.47.005 5.116 2.008 5.898 2.962l.244.3c1.64 1.994 3.569 4.34 3.569 6.966 0 3.719-2.98 5.808-6.158 7.508-1.433.766-2.98 1.508-4.748 1.508-4.543 0-8.366-3.569-8.366-8.112 0-.706.17-1.425.342-2.15.122-.515.244-1.033.307-1.549.548-4.539 2.967-6.795 8.422-7.408a4.29 4.29 0 01.49-.026Z"/></svg>`;

/** Ghost Admin API: https://ghost.org/docs/admin-api/ */
export const ghost = defineConnector(
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
  {
    title: "Ghost",
    logo: { svg: glyph("#15171A"), dark: glyph("white") },
    package: "@sanoma/connector-ghost",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/ghost#readme",
  },
);
