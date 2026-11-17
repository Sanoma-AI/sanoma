import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

// src/content/docs is a link to packages/sanoma/docs: the pages live in the `sanoma` package, which
// ships them (node_modules/sanoma/docs), so there is one copy, read by the site and by whoever has
// the package installed. A link, not a loader's `base`, because Starlight and its plugins find a
// page's file under src/content/docs (the edit link, the links validator).
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
