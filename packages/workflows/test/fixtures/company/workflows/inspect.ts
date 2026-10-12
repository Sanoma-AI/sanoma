import { github } from "@sanoma/connector-github";
import { stripe } from "@sanoma/connector-stripe";
import { z } from "zod";
import { defineWorkflow } from "../../../../src/index.ts";

/**
 * Inspect a repository and a product: read each as the vendor holds it now. A repository
 * GitHub no longer has ends the inspection before the product is read.
 */
export default defineWorkflow({
  name: "inspect",
  title: "Inspect a repository and a product",
  trigger: "manual",
  input: z.object({ repository: z.string().min(1), product: z.string().min(1) }),
  uses: [github.repository.import, stripe.product.import],
  run: async (ctx, { repository, product }) => {
    const repo = await ctx.github.repository.import({ id: repository });
    let name: string | null = null;
    // A repository GitHub no longer has ends the inspection: the product is not read.
    if (!repo.gone) {
      const read = await ctx.stripe.product.import({ id: product });
      name = read.state?.name ?? null;
    }
    return { repository: repo.state?.description ?? null, product: name };
  },
});
