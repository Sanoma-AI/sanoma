// @ts-check
import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig, fontProviders } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";

const REPO = "https://github.com/Sanoma-AI/sanoma";

/**
 * What scripts/reference.ts wrote: the connectors, for the sidebar's links to their pages. The
 * `dev`, `start` and `build` scripts write it first; `astro` run by itself needs it written.
 * @type {{ slug: string; title: string }[]}
 */
const connectors = JSON.parse(readFileSync(new URL("./src/data/reference.json", import.meta.url), "utf8"));

// https://astro.build/config
// The guides are src/content/docs; the connector reference is drawn from the connectors' own
// source (scripts/reference.ts).
export default defineConfig({
  site: "https://docs.sanoma.work",
  // A page loads when its link is hovered, so moving between pages is near instant.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  // The website's type, by Astro's fonts (docs.astro.build/en/guides/fonts): downloaded from
  // Fontsource at build, served from /_astro/fonts, and written into each page by
  // src/components/Head.astro.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "IBM Plex Sans",
      cssVariable: "--font-plex-sans",
      weights: ["100 700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "Fraunces",
      cssVariable: "--font-fraunces",
      weights: ["100 900"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["Georgia", "serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "IBM Plex Mono",
      cssVariable: "--font-plex-mono",
      weights: [400, 600],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
  integrations: [
    starlight({
      title: "Sanoma",
      description: "Run a company's operations as code: workflows, policies, sites and the connectors they call.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      social: [{ icon: "github", label: "Sanoma on GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs-site/` },
      customCss: ["./src/styles/sanoma.css"],
      components: {
        Head: "./src/components/Head.astro",
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      // Cedar has no grammar in Shiki: a policy is shown as plain text.
      expressiveCode: { shiki: { langAlias: { cedar: "txt" } } },
      sidebar: [
        {
          label: "Set up a company",
          items: ["start/setup", "start/start-a-company", "start/install", "start/first-workflow"],
        },
        {
          label: "Use your company’s app",
          items: ["start/the-app", { autogenerate: { directory: "using-the-app" } }],
        },
        {
          label: "Build with Sanoma",
          items: [
            "build/overview",
            {
              label: "Workflows",
              items: [
                "workflows/writing-workflows",
                "workflows/built-ins",
                "workflows/collections",
                "workflows/your-own-operations",
                "workflows/direct-calls",
                "workflows/resources",
                "workflows/credentials",
                "workflows/ledger",
                "workflows/approvals",
                "workflows/changes",
                "workflows/replay-safety",
                "workflows/your-own-ui",
              ],
            },
            { label: "Sites", items: [{ autogenerate: { directory: "sites" } }] },
            {
              label: "Building connectors",
              items: ["building-connectors/define-a-connector", "workflows/connectors", "building-connectors/setup"],
            },
            "start/apps",
            "start/agents-over-mcp",
          ],
        },
        { label: "People and policies", items: [{ autogenerate: { directory: "policies" } }] },
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
