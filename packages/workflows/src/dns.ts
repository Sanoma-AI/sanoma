import { z } from "zod";

/**
 * A DNS record as one resource's state gives it and another's input takes it, through a `from`
 * reference (`FieldReference.from`): the records a sending domain asks for (`resend.domain`'s
 * `dns_records`), which a zone's record set writes (`cloudflare.records`' `records`).
 */
export const dnsRecord = z.object({
  type: z.enum(["TXT", "MX", "CNAME", "CAA"]),
  /** The full name, lower case, with no trailing dot: `resend._domainkey.example.com`. */
  name: z.string(),
  /** As the zone holds it: a TXT record's text unquoted. */
  content: z.string(),
  /** An MX record's priority. */
  priority: z.number().int().optional(),
  /** In seconds; 1 is automatic, the zone's default. */
  ttl: z.number().int().optional(),
});

/** One DNS record: see `dnsRecord`. */
export type DnsRecord = z.infer<typeof dnsRecord>;
