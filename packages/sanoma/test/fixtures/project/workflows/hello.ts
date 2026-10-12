import { ghost } from "@sanoma/connector-ghost";
import { defineWorkflow } from "sanoma";
import { z } from "zod";

export default defineWorkflow({
  name: "hello",
  title: "Say hello",
  trigger: "manual",
  input: z.object({ title: z.string().min(1) }),
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, { title }) => {
    const post = await ctx.ghost.post.create({ title, html: `<p>${title}</p>`, status: "draft" });
    const published = await ctx.ghost.post.publish({ id: post.id });
    return { url: published.url };
  },
});
