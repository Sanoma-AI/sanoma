import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { defineFake, type FakeOptions } from "@sanoma/workflows/fake";
import { z } from "zod";
import { defineConnector, defineWorkflow } from "../../src/index.ts";

/** A vendor to read from after the fan-out: how a post and an email did. */
export const stats = defineConnector("stats", {
  post: {
    views: { effect: "read", input: z.object({ url: z.string() }), output: z.object({ views: z.number() }) },
  },
  email: {
    opens: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ opens: z.number() }) },
  },
});

/** An in-memory stats vendor: every post has 42 views, every email 7 opens. */
export const fakeStats = (options?: FakeOptions) =>
  defineFake(
    stats,
    {
      initial: () => ({}),
      ops: () => ({
        post: { views: async () => ({ views: 42 }) },
        email: { opens: async () => ({ opens: 7 }) },
      }),
    },
    options,
  );

/**
 * Fan a launch out to three vendors at once, wait a second, then read back how two of them did,
 * also at once.
 */
const fanout = defineWorkflow({
  name: "fanout",
  title: "Fan a launch out",
  trigger: "manual",
  input: z.object({ title: z.string().min(1) }),
  uses: [
    ghost.post.create,
    resend.broadcast.create,
    bluesky.post.create,
    stats.post.views,
    stats.email.opens,
    "all",
    "sleep",
  ],
  run: async (ctx, { title }) => {
    const [post, email, social] = await ctx.all([
      () => ctx.ghost.post.create({ title, html: `<p>${title}</p>`, status: "draft" }),
      () => ctx.resend.broadcast.create({ audience: "newsletter", subject: title, html: `<p>${title}</p>` }),
      () => ctx.bluesky.post.create({ text: title }),
    ]);
    await ctx.sleep({ seconds: 1 });
    const [views, opens] = await ctx.all([
      () => ctx.stats.post.views({ url: social.url }),
      () => ctx.stats.email.opens({ id: email.id }),
    ]);
    return { post: post.url, views: views.views, opens: opens.opens };
  },
});
export default fanout;
