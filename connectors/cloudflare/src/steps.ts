import { defineSteps } from "sanoma/workflows";
import { cloudflareOps } from "./connector.ts";

const { create } = cloudflareOps.container;

/** The runtime image the steps' containers name: one already in the account's registry, pinned by digest, so nothing copies or asks for it. */
const IMAGE =
  "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime@sha256:7777777777777777777777777777777777777777777777777777777777777777";

/**
 * Cloudflare's steps for Gherkin tests: a company's container before the run (named `host`, so
 * an operation's own test can use `$host.state.url`), its secrets carrying the wakeup token and
 * its database's URL.
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
        secrets: {
          SANOMA_WAKEUP_TOKEN: { $secret: "SANOMA_WAKEUP_TOKEN", generate: true },
          // Made up: Hyperdrive's origin is made of it, and nothing connects to it.
          SANOMA_DATABASE_URL: "postgresql://sanoma:test@db.acme.example:5432/company",
        },
      },
    },
    as: "host",
  }));
});
