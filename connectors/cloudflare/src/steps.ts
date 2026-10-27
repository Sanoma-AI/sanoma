import { defineSteps } from "@sanoma-ai/workflows";
import { cloudflareOps } from "./connector.ts";

const { create } = cloudflareOps.container;

/** The runtime image the steps' containers name: one already in Cloudflare's registry, so nothing copies it. */
const IMAGE = "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime:0.7.0";

/**
 * Cloudflare's steps for Gherkin tests: a company's container before the run (named `host`, so
 * an operation's own test can use `$host.state.url`), its secrets carrying the wakeup token.
 */
export const cloudflareSteps = defineSteps("cloudflare", ({ given }) => {
  given("a Cloudflare container for {string} at revision {string}", (name: string, revision: string) => ({
    op: create,
    input: {
      desired: {
        name,
        image: IMAGE,
        source: `https://github.com/acme/${name}.git`,
        ref: "main",
        revision,
        port: 3000,
        secrets: { SANOMA_WAKEUP_TOKEN: { $secret: "SANOMA_WAKEUP_TOKEN", generate: true } },
      },
    },
    as: "host",
  }));
});
