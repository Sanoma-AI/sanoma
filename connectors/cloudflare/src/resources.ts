import { alarm, container, records } from "./connector.ts";

/**
 * The constructors a data file declares the company's Cloudflare host and its wakeup with:
 * `export const host = cloudflare.container({ name: "acme", image: "ghcr.io/sanoma-ai/runtime:0.7.0", source: repo, ref: "main", port: 3000, secrets: { SANOMA_DATABASE_URL: secret("SANOMA_DATABASE_URL"), SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN", { generate: true }) } })`
 * and `export const wakeup = cloudflare.alarm({ host })`, and a set of DNS records, such as a
 * sending domain's: `export const mailDns = cloudflare.records({ zone: "example.com", name: "resend", records: mail })`.
 */
export const cloudflare = { container, alarm, records };
