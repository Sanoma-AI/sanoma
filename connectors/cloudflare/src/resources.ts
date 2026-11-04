import { alarm, container, host, records } from "./connector.ts";

/**
 * The constructors a data file declares the company's Cloudflare host and its wakeup with:
 * `export const host = cloudflare.host({ name: "acme", hostname: "internal.acme.example", database: store })`,
 * whose image, source, ref, port, domains and secrets apply gives it (`cloudflare.container` is
 * its deprecated form, which names them all), `export const wakeup = cloudflare.alarm({ host })`,
 * and a set of DNS records, such as a sending domain's:
 * `export const mailDns = cloudflare.records({ zone: "example.com", name: "resend", records: mail })`.
 */
export const cloudflare = { host, container, alarm, records };
