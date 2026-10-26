import { alarm, container } from "./connector.ts";

/**
 * The constructors a data file declares the company's Cloudflare host and its wakeup with:
 * `export const host = cloudflare.container({ name: "acme", image: "docker.io/sanomaai/runtime:0.7.0", source: repo, ref: "main", port: 3000, secrets: { SANOMA_DATABASE_URL: secret("SANOMA_DATABASE_URL"), SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN") } })`
 * and `export const wakeup = cloudflare.alarm({ host })`.
 */
export const cloudflare = { container, alarm };
