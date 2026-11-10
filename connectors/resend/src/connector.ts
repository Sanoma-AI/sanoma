import { compareDeclared, defineConnector, defineResource, dnsRecord, DriverError, vendorInfo } from "sanoma/workflows";
import { DOMAIN_NAME } from "sanoma/workflows/shared";
import { z } from "zod";

/** The regions Resend sends from (https://resend.com/docs/api-reference/domains/create-domain). */
const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export type Region = (typeof REGIONS)[number];
/** The region a domain sends from when its declaration names none: Resend's default. */
export const DEFAULT_REGION = "us-east-1";
/** The Return-Path subdomain when a declaration names none: Resend's default (`send.example.com`). */
export const DEFAULT_RETURN_PATH = "send";

/** A domain's status at Resend: `verified` once its DNS records are found, the rest until then or when they are lost. */
const STATUSES = [
  "not_started",
  "pending",
  "verified",
  "failed",
  "temporary_failure",
  "partially_verified",
  "partially_failed",
] as const;
export type DomainStatus = (typeof STATUSES)[number];

/** A DNS record as Resend gives it: its own fields, its name as Resend writes it. */
export const resendRecord = z.object({
  record: z.string().describe("What it is for: `SPF` and `DKIM` for sending, `Receiving`, `Tracking`, `TrackingCAA`"),
  name: z.string(),
  type: z.string(),
  value: z.string(),
  ttl: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().optional(),
});

/** A sending domain as the operations read it: what a data file declares, and what Resend sets. */
const domainSchema = z.object({
  name: z
    .string()
    .regex(DOMAIN_NAME, "a domain name in lower case, such as `example.com` or `mail.example.com`")
    .describe("The domain to send from, such as `example.com`, or a subdomain such as `mail.example.com`"),
  region: z
    .enum(REGIONS)
    .optional()
    .describe("Where Resend sends from: `us-east-1` (the default), `eu-west-1`, `sa-east-1` or `ap-northeast-1`"),
  custom_return_path: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "one DNS label in lower case, such as `send`")
    .optional()
    .describe("The Return-Path subdomain, `send` by default (`send.example.com`)"),
  id: z.string().optional().describe("The domain's id at Resend"),
  status: z.enum(STATUSES).optional().describe("Whether Resend found its DNS records: `verified` once it has"),
  records: z.array(resendRecord).optional().describe("The DNS records Resend asks for, as Resend gives them"),
  dns_records: z
    .array(dnsRecord)
    .optional()
    .describe("The same records as a zone holds them: full lower-case names, TXT text unquoted, ttl 1 for automatic"),
});

/** A domain's fields: what Resend sets, and what it cannot change in place. */
const fields = {
  immutable: ["name", "region", "custom_return_path"],
  vendorOwned: ["id", "status", "records", "dns_records"],
  writeOnly: [],
} as const;

/**
 * `resend.domain({ name, region?, custom_return_path? })`: a domain Resend sends from. Apply
 * creates it and asks Resend to verify it, which Resend keeps checking for 72 hours; its
 * `dns_records` are what the zone must hold, which `cloudflare.records` takes (`from:
 * "dns_records"`). A domain is declared verified, so one Resend has not verified is drift, and
 * apply asks Resend to verify it again.
 */
export const domain = defineResource({
  vendor: "resend",
  type: "domain",
  title: "Domain",
  identity: "name",
  schema: domainSchema,
  fields,
  find: ({ name }) => name,
  bindingId: (state) => String(state.id),
  // The status is compared too, declared `verified` (a declaration never holds one). A Return-Path
  // the records do not show (no SPF record read) is not drift: the read cannot tell it.
  normalize: (state, desired) => ({
    ...compareDeclared(fields, state, desired),
    ...(state.custom_return_path === undefined && { custom_return_path: desired.custom_return_path }),
    status: state.status ?? "verified",
  }),
  writable: true,
  // Its DKIM key is Resend's: one made again needs new DNS records, so apply asks first.
  stateless: false,
});

/** A broadcast's or an email's sender: Resend requires one, and the environment gives none. */
const sender = z
  .string()
  .min(1)
  .describe("The sender, such as `Acme <news@acme.example>`, on a domain verified in Resend");

/**
 * The sender, the input's `from` (unless empty): the driver and the fake refuse a send with none,
 * as the schema does, for a call that skipped it.
 */
export function senderOf(op: string, from: string | undefined): string {
  if (from) return from;
  throw new DriverError(
    `resend: ${op} needs \`from\` in its input, a sender on a domain verified in Resend (for sign-in codes, the config's \`login.from\`)`,
    { retryable: false },
  );
}

/**
 * Resend's Broadcasts API (https://resend.com/docs/api-reference/broadcasts), its one-email send
 * (https://resend.com/docs/api-reference/emails/send-email) and its sending domains, the resource
 * type `resend.domain` (https://resend.com/docs/api-reference/domains).
 */
export const resendOps = defineConnector(
  "resend",
  {
    domain,
    broadcast: {
      create: {
        effect: "write",
        description: "Create a broadcast to an audience. Nothing is sent.",
        input: z.object({
          audience: z.string().min(1),
          from: sender,
          subject: z.string().min(1),
          html: z.string(),
        }),
        output: z.object({ id: z.string() }),
      },
      send: {
        effect: "send",
        description: "Send a broadcast to every contact in its audience. Cannot be undone.",
        phrases: { expect: "broadcast {id} is sent" },
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), status: z.enum(["queued", "sent"]) }),
      },
    },
    emails: {
      send: {
        effect: "send",
        description: "Send one email to an address, or to a list of up to 50, with files attached. Cannot be undone.",
        input: z
          .object({
            to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]),
            from: sender,
            subject: z.string().min(1),
            html: z.string().optional(),
            text: z.string().optional(),
            attachments: z
              .array(
                z.object({
                  filename: z.string().min(1).describe("The file's name, such as `invoice-001.pdf`"),
                  content: z.base64().min(1).describe("The file's bytes, base64-encoded"),
                }),
              )
              .optional()
              .describe("Files to attach; Resend takes up to 40 MB per email, encoded"),
          })
          .refine((email) => Boolean(email.html || email.text), {
            message: "an email needs `html`, `text` or both, not empty",
          }),
        output: z.object({ id: z.string() }),
        // The files' bytes stay out of the ledger, which keeps each one's name and `content: "<content>"`.
        opaque: ["attachments.content"],
      },
    },
  },
  vendorInfo(import.meta.url),
);
