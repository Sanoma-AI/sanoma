import {
  compareDeclared,
  type Connector,
  defineConnector,
  defineResource,
  type DnsRecord,
  dnsRecord,
  type OpSpec,
  type ResourceFields,
  vendorInfo,
} from "@sanoma-ai/workflows";
import { DOMAIN_NAME, SITE_KEY } from "@sanoma-ai/workflows/shared";
import { z } from "zod";

/*
 * Cloudflare, over its official SDK (`cloudflare`): one Worker per company that runs the company
 * in a Container behind its one Durable Object (`cloudflare.container`, a host), and the same
 * object's alarm, which wakes it (`cloudflare.alarm`, a wakeup). Cloudflare's OpenTofu provider
 * has no container resource, so the schemas are a cut of the API's own fields, by hand.
 */

/** A company's name as its Worker's is made of it (`sanoma-<name>`): a DNS label of 63 characters at most. */
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;

const containerSchema = z.object({
  id: z.string().nullish().describe("The container application's id, which Cloudflare sets"),
  name: z
    .string()
    .regex(NAME, "lower case letters, digits and dashes, 56 at most")
    .describe(
      "The company's name: its Worker is `sanoma-<name>`, its URL `https://sanoma-<name>.<account>.workers.dev`",
    ),
  image: z
    .string()
    .regex(/^[^\s@]+(:[\w][\w.-]{0,127}|@sha256:[0-9a-f]{64})$/, "pin the image to a tag or a digest")
    .refine((image) => !image.endsWith(":latest"), "pin the image to a version, not `latest`")
    .describe(
      "The Sanoma runtime image, pinned to a tag or a digest: `ghcr.io/sanoma-ai/runtime:<version>`, which apply copies into the account's registry",
    ),
  source: z.string().min(1).describe("The company repository's clone URL, or a declared GitHub repository"),
  ref: z.string().min(1).describe("The branch it runs, such as `main`, never a commit"),
  revision: z.string().nullish().describe("The commit it runs, which apply sets from `ref`"),
  secrets: z
    .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
    .nullish()
    .describe(
      "Environment variables holding secrets, each a `secret(...)`: SANOMA_DATABASE_URL, SANOMA_SECRETS_KEY, SANOMA_WAKEUP_TOKEN",
    ),
  port: z.number().int().min(1).max(65_535).describe("The port the runtime listens on in the container (its `PORT`)"),
  domains: z
    .record(z.string().regex(SITE_KEY), z.string().regex(DOMAIN_NAME))
    // Empty, it would read back as none, a change on every plan.
    .refine((domains) => Object.keys(domains).length > 0, "leave `domains` out rather than empty")
    .nullish()
    .describe("A public site's domain, by site name"),
  url: z.string().nullish().describe("The Worker's URL on workers.dev, which Cloudflare sets"),
  healthy: z
    .boolean()
    .nullish()
    .describe("Whether the application exists and the Worker answers /__sanoma/health, which starts the container"),
});

/**
 * `cloudflare.container`: the company's Worker, `sanoma-<name>`, on the account's workers.dev
 * subdomain, whose one Durable Object (`SanomaInstance`) starts the runtime image in a Container
 * on a request and stops it ten minutes after the last (`Host`: stops when quiet, its URL public).
 * What it runs is in the Worker's plain-text bindings, so a read tells its revision with no
 * container running. A deploy uploads the Worker again; a new image is copied into the account's
 * registry (one there by a tag is pinned to its digest) and named by the upload, and the object
 * starts the container again at it.
 */
export const container = defineResource({
  vendor: "cloudflare",
  type: "container",
  title: "Container",
  identity: "name",
  schema: containerSchema,
  fields: {
    immutable: ["name"],
    vendorOwned: ["id", "url", "healthy"],
    writeOnly: ["secrets"],
    references: { source: { type: "github.repository", by: ["http_clone_url"] } },
  },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
  host: {
    capabilities: { lifetime: "stops-when-quiet", publicUrl: true, buildsFromGit: false, staticEgress: false },
    inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port", domains: "domains" },
    revision: "revision",
    outputs: (state) => ({
      url: String(state.url ?? ""),
      ...(typeof state.revision === "string" && { revision: state.revision }),
      healthy: state.healthy === true,
    }),
  },
});

const alarmSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("The host's URL, whose Worker holds the alarm: a data file names the host's declaration"),
  at: z.string().nullish().describe("When the instance asked to be woken last, null until it has"),
  rang: z
    .string()
    .nullish()
    .describe("When the alarm last rang the host's /wake for that registration, null until it has"),
  healthy: z.boolean().nullish().describe("Whether the host's Worker answers its wake route with this company's token"),
  token: z
    .string()
    .nullish()
    .describe(
      "The secret that holds the host's wakeup token, a `secret(\"NAME\")`: the one the host's secrets give as SANOMA_WAKEUP_TOKEN, by default SANOMA_WAKEUP_TOKEN itself. A state gives its name when it is another",
    ),
});

/**
 * `cloudflare.alarm({ host })`: the Durable Object alarm of the host's own Worker, which starts
 * the container at the time the worker registered and calls its `/wake`. The alarm
 * is the host's object's, so it has no id of its own: its binding is the host's URL, and a new
 * host is a new alarm. The host's `secrets` must carry `SANOMA_WAKEUP_TOKEN`, which `create`
 * mints when none is stored, under the store name `token` gives (`secret("NAME")`), by default
 * `SANOMA_WAKEUP_TOKEN`: a workflow that makes hosts for several companies names one per company.
 * The state keeps that name, so a `read`, `update` or `delete` given the state sends the same token.
 */
export const alarm = defineResource({
  vendor: "cloudflare",
  type: "alarm",
  title: "Alarm",
  schema: alarmSchema,
  fields: {
    immutable: ["host"],
    vendorOwned: ["at", "rang", "healthy"],
    writeOnly: ["token"],
    references: { host: { type: ["cloudflare.container"], by: ["url"] } },
  },
  bindingId: (state) => String(state.host),
  writable: true,
  // The host's object holds the registered wake: apply asks before it deletes one (not stateless).
  wakeup: {
    inputs: { host: "host" },
    register: "cloudflare.alarm.register",
    outputs: (state) => ({ healthy: state.healthy === true }),
  },
});

/** A set's label: lower case letters, digits, `-` and `_`. */
const LABEL = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

const recordsSchema = z.object({
  zone: z
    .string()
    .regex(DOMAIN_NAME, "a zone's name, lower case, such as `example.com`")
    .describe("The zone's name, as the account holds it: `example.com`"),
  name: z
    .string()
    .regex(LABEL, "lower case letters, digits, `-` and `_`")
    .describe(
      "The set's label, such as `resend`: its identity is `<zone>/<name>`, and each record it writes carries the comment `sanoma:<zone>/<name>`",
    ),
  records: z
    .array(dnsRecord)
    // Empty, it would read back as gone, a create on every apply.
    .min(1, "a set holds at least one record: leave it out rather than empty")
    .describe(
      "The records, compared as a set: a list, or a declared `resend.domain`, whose `dns_records` they are then",
    ),
  zone_id: z.string().nullish().describe("The zone's id, which Cloudflare sets"),
  record_ids: z
    .array(z.string())
    .nullish()
    .describe("Each record's id, which Cloudflare sets, in the order of `records` as a read gives them"),
});

/** A TXT record's text as a zone may show it, quoted (`"v=spf1 …"`) or split in quoted strings (`"…" "…"`), unquoted. */
function unquoted(content: string) {
  const text = content.trim();
  if (!/^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*$/s.test(text)) return content;
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/gs)].map(([, part = ""]) => part.replace(/\\(.)/gs, "$1")).join("");
}

/** A CAA record's content, `0 issue "letsencrypt.org"`, as the fields Cloudflare takes; undefined when it is not one. */
export function caaData(content: string) {
  const parts = /^(\d+)\s+(\S+)\s+(.+)$/s.exec(content.trim());
  if (!parts) return undefined;
  const [, flags, tag, value] = parts as unknown as [string, string, string, string];
  return { flags: Number(flags), tag, value: value.replace(/^"(.*)"$/s, "$1") };
}

/** A CAA record's fields as its content, as Cloudflare shows them: `caaData`'s reverse. */
export const caaContent = ({ flags, tag, value }: { flags: number; tag: string; value: string }) =>
  `${flags} ${tag} "${value}"`;

/** A record's content in its compared form: a TXT record's text unquoted, a CAA record's value quoted. */
function contentOf(type: string, content: string) {
  if (type === "TXT") return unquoted(content);
  const caa = type === "CAA" ? caaData(content) : undefined;
  return caa ? caaContent(caa) : content;
}

/** A record as a zone or a declaration gives it, as far as a set compares it. */
interface AnyRecord {
  type: string;
  name: string;
  content: string;
  priority?: number | null | undefined;
  ttl?: number | null | undefined;
}

/**
 * One record in the one form a set compares: its name in lower case with no trailing dot, a TXT
 * record's text unquoted, a CAA record's value quoted, a priority for an MX record only, and a
 * ttl, 1 (automatic) unless given.
 */
export const canonicalRecord = ({ type, name, content, priority, ttl }: AnyRecord): DnsRecord => ({
  type: type as DnsRecord["type"],
  name: name.toLowerCase().replace(/\.$/, ""),
  content: contentOf(type, content),
  ...(type === "MX" && typeof priority === "number" && { priority }),
  ttl: ttl ?? 1,
});

const recordsFields = {
  immutable: ["zone", "name"],
  vendorOwned: ["zone_id", "record_ids"],
  writeOnly: [],
  unordered: ["records"],
  references: { records: { type: ["resend.domain"], from: "dns_records" } },
} as const satisfies ResourceFields;

/** A state or a declaration with its records in their compared form (`canonicalRecord`), each once, as a plan has them. */
const canonicalSet = (state: Record<string, unknown>) => {
  if (!Array.isArray(state.records)) return state;
  const records = (state.records as AnyRecord[]).map((record) => canonicalRecord(record));
  return { ...state, records: [...new Map(records.map((r) => [JSON.stringify(r), r])).values()] };
};

/**
 * `cloudflare.records({ zone, name, records })`: a set of DNS records in one of the account's
 * zones, `<zone>/<name>`, compared as a set. Each record it writes carries the comment
 * `sanoma:<zone>/<name>`, which is how a read finds them; a record without it is never changed or
 * deleted, except one identical to a declared record in type, name, content (and an MX record's
 * priority), which is adopted (its comment replaced by the mark), and is deleted with the set from then on.
 * `records` may name a `resend.domain`, whose `dns_records` it then takes (`from`): a sending
 * domain's records go to the zone that holds them.
 */
export const records = defineResource({
  vendor: "cloudflare",
  type: "records",
  title: "DNS records",
  identity: "zone/name",
  schema: recordsSchema,
  fields: recordsFields,
  find: ({ zone, name }) => `${zone}/${name}`,
  bindingId: (state) => `${String(state.zone)}/${String(state.name)}`,
  // Drift compares each record as `canonicalRecord` has it: a ttl left out is automatic, as read.
  normalize: (state, desired) => compareDeclared(recordsFields, canonicalSet(state), canonicalSet(desired)),
  writable: true,
  // Records hold no data: a set deleted by hand is written again without asking.
  stateless: true,
});

const types = defineConnector("cloudflare", { container, alarm, records }, vendorInfo(import.meta.url));

/** `alarm.register`, in the alarm type's own group, beside its resource operations. */
const registerSpec = {
  register: {
    effect: "write",
    // Each replaces the wake registered before: a retry changes nothing.
    idempotent: true,
    description: "Set the host's alarm to wake it at `at`, replacing the wake registered before",
    input: z.object({ at: z.iso.datetime({ offset: true }).describe("When to wake the host, ISO 8601") }),
    output: z.object({}),
  },
} satisfies Record<string, OpSpec>;

const register = defineConnector("cloudflare", { alarm: registerSpec });

/** The connector's specs: each type's operations, and `register` in the alarm's group. */
type CloudflareSpecs = {
  container: (typeof container)["ops"];
  records: (typeof records)["ops"];
  alarm: (typeof alarm)["ops"] & typeof registerSpec;
};

/**
 * The connector's operations: each type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`) and `alarm.register` in the alarm's group (Supabase's pattern).
 */
export const cloudflareOps = {
  ...types,
  alarm: { ...types.alarm, ...register.alarm },
} as unknown as Connector<"cloudflare", CloudflareSpecs>;

/** The connector's type: the three types, with `alarm.register`. */
export type CloudflareOps = typeof cloudflareOps;
