import { type Connector, defineConnector, defineResource, type OpSpec, vendorInfo } from "@sanoma-ai/workflows";
import { DOMAIN_NAME, SITE_NAME } from "@sanoma-ai/workflows/shared";
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
      "The Sanoma runtime image on Docker Hub, pinned to a tag or a digest: `docker.io/sanomaai/runtime:<version>`",
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
    .record(z.string().regex(SITE_NAME), z.string().regex(DOMAIN_NAME))
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
 * container running. A deploy uploads the Worker again; a new image rolls the application out.
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
  generation: z.number().int().nullish().describe("The generation of that registration, 0 until one"),
  healthy: z.boolean().nullish().describe("Whether the host's Worker answers its wake route with this company's token"),
});

/**
 * `cloudflare.alarm({ host })`: the Durable Object alarm of the host's own Worker, which starts
 * the container at the time the worker registered and calls its `/wake?generation=N`. The alarm
 * is the host's object's, so it has no id of its own: its binding is the host's URL, and a new
 * host is a new alarm. The host's `secrets` must carry `SANOMA_WAKEUP_TOKEN`, which `create`
 * mints when none is stored.
 */
export const alarm = defineResource({
  vendor: "cloudflare",
  type: "alarm",
  title: "Alarm",
  schema: alarmSchema,
  fields: {
    immutable: ["host"],
    vendorOwned: ["at", "generation", "healthy"],
    writeOnly: [],
    references: { host: { type: ["cloudflare.container"], by: ["url"] } },
  },
  bindingId: (state) => String(state.host),
  writable: true,
  // The host's object holds the registered wake: apply asks before it deletes one.
  stateless: false,
  wakeup: {
    inputs: { host: "host" },
    register: "cloudflare.alarm.register",
    outputs: (state) => ({ healthy: state.healthy === true }),
  },
});

const types = defineConnector("cloudflare", { container, alarm }, vendorInfo(import.meta.url));

/** `alarm.register`, in the alarm type's own group, beside its resource operations. */
const registerSpec = {
  register: {
    effect: "write",
    // The object applies a generation only when it is newer: a retry changes nothing.
    idempotent: true,
    description:
      "Set the host's alarm to wake it at `at` with `generation`, replacing the wake registered before unless that one is newer",
    input: z.object({
      at: z.iso.datetime({ offset: true }).describe("When to wake the host, ISO 8601"),
      generation: z.number().int().min(1).describe("Counts up from 1: only a newer one replaces the wake"),
    }),
    output: z.object({}),
  },
} satisfies Record<string, OpSpec>;

const register = defineConnector("cloudflare", { alarm: registerSpec });

/** The connector's specs: both types' operations, and `register` in the alarm's group. */
type CloudflareSpecs = {
  container: (typeof container)["ops"];
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

/** The connector's type: both types, with `alarm.register`. */
export type CloudflareOps = typeof cloudflareOps;
