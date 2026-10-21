import { ghost } from "@sanoma-ai/connector-ghost";
import { defineWorkflow, z } from "sanoma";

/** Draft a blog post, then publish it: the policy has an editor review it first (policies/policy.cedar). */
export default defineWorkflow({
  name: "publish-post",
  title: "Publish a post",
  trigger: "manual",
  input: z.object({
    title: z.string().min(1),
    /** The post's body, as HTML. */
    html: z.string().min(1),
  }),
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, { title, html }) => {
    const post = await ctx.ghost.post.create({ title, html, status: "draft" }, { name: "Draft the post" });
    const published = await ctx.ghost.post.publish({ id: post.id }, { name: "Publish the post" });
    return { url: published.url };
  },
});
