import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { defineWorkflow } from "../../src/index.ts";
import { z } from "zod";

/**
 * Announce something: draft the blog post and the newsletter, get the copy
 * approved, then publish everywhere at the launch time.
 */
export default defineWorkflow({
  name: "announce",
  title: "Announce a launch",
  trigger: "manual",
  input: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    launchAt: z.iso.datetime({ offset: true }),
    audience: z.string().default("newsletter"),
  }),
  uses: [
    ghost.post.create,
    ghost.post.publish,
    resend.broadcast.create,
    resend.broadcast.send,
    bluesky.post.create,
    "approval",
    "sleep",
  ],
  run: async (ctx, { title, body, launchAt, audience }) => {
    const post = await ctx.ghost.post.create({ title, html: body, status: "draft" });
    const email = await ctx.resend.broadcast.create({ audience, subject: title, html: body });

    await ctx.approval("Review launch copy", {
      approver: "marketing-lead",
      links: [post.url],
      details: `Email to "${audience}"`,
    });
    await ctx.sleep({ until: launchAt });

    const published = await ctx.ghost.post.publish({ id: post.id });
    await ctx.resend.broadcast.send({ id: email.id });
    const social = await ctx.bluesky.post.create({ text: `${title} ${published.url}` });

    return { post: published.url, email: email.id, social: social.url };
  },
});
