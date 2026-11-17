// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";

const REPO = "https://github.com/Sanoma-AI/sanoma";

/** What scripts/reference.ts wrote: the connectors, for the sidebar's links to their pages. */
const referenceFile = fileURLToPath(new URL("./src/data/reference.json", import.meta.url));
/** @type {{ slug: string; title: string }[]} */
const connectors = existsSync(referenceFile) ? JSON.parse(readFileSync(referenceFile, "utf8")) : [];

// https://astro.build/config
// The guides are src/content/docs; the connector reference is drawn from the connectors' own
// source (scripts/reference.ts).
export default defineConfig({
  site: "https://docs.sanoma.work",
  integrations: [
    starlight({
      title: "Sanoma",
      description: "Run a company's operations as code: workflows, policies, sites and the connectors they call.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "Sanoma on GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs-site/` },
      customCss: ["./src/styles/sanoma.css"],
      components: { Footer: "./src/components/Footer.astro" },
      lastUpdated: false,
      // Cedar has no grammar in Shiki: a policy is shown as plain text.
      expressiveCode: { shiki: { langAlias: { cedar: "txt" } } },
      sidebar: [
        { label: "Start", items: [{ autogenerate: { directory: "start" } }] },
        { label: "Workflows", items: [{ autogenerate: { directory: "workflows" } }] },
        { label: "People and policies", items: [{ autogenerate: { directory: "policies" } }] },
        { label: "Sites", items: [{ autogenerate: { directory: "sites" } }] },
        { label: "Testing", items: [{ autogenerate: { directory: "testing" } }] },
        { label: "Hosting", items: [{ autogenerate: { directory: "hosting" } }] },
        {
          label: "Reference",
          items: [
            { autogenerate: { directory: "reference" } },
            {
              label: "Connectors",
              collapsed: true,
              items: [
                { label: "All connectors", link: "/reference/connectors/" },
                ...connectors.map(({ slug, title }) => ({ label: title, link: `/reference/connectors/${slug}/` })),
              ],
            },
          ],
        },
      ],
      plugins: [
        // A link to a page or heading that is not there fails the build. The connectors' pages are
        // made by src/pages, which the validator does not read.
        starlightLinksValidator({ exclude: ["/reference/connectors/**"] }),
        // /llms.txt, /llms-full.txt and /llms-small.txt: the same pages, for an agent.
        starlightLlmsTxt({ projectName: "Sanoma" }),
      ],
    }),
  ],
});
