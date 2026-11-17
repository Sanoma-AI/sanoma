import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// As the Starlight template has it. src/content/docs is a link to packages/sanoma/docs: the pages
// live in the `sanoma` package, which ships them, so the site and the package hold one copy.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
