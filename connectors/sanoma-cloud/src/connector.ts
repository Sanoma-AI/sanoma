import {
  compareDeclared,
  type Connector,
  defineConnector,
  defineResource,
  type OpSpec,
  vendorInfo,
} from "@sanoma-ai/workflows";
import { DOMAIN_NAME, SITE_KEY } from "@sanoma-ai/workflows/shared";
import { z } from "zod";

/*
 * Sanoma Cloud: the company's database and host in Sanoma's own accounts, a vendor the company's
 * repository declares like any other. Its API is four of sanoma-ops's workflows (`cloud-signup`,
 * `cloud-list`, `cloud-deploy`, `cloud-close`), started over the public api of www.sanoma.work
 * with the company's Cloud token; the schemas are a cut of their fields, by hand.
 */

/**
 * The regions a Cloud database takes, each a Neon region in the Cloud's organization, as
 * sanoma-ops's `cloud-signup` maps them: AWS us-east-1, us-west-2, eu-central-1, eu-west-2, ap-southeast-1.
 */
export const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-southeast"] as const;

/** A company's slug, its address `<slug>.sanoma.work`: as sanoma-ops's sign-up checks it. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/** The port the runtime listens on in a Cloud host: the Cloud's, whatever is declared. */
export const PORT = 3000;

/** The repository `source` names, a clone URL or a declared repository's `owner/name`: its owner and name. */
export function repositoryOf(source: unknown): { owner: string; name: string } | undefined {
  if (typeof source !== "string") return undefined;
  const path = URL.canParse(source) ? new URL(source).pathname : source;
  const [owner, name] = path
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2);
  return owner && name ? { owner, name } : undefined;
}

/** The repository `source` names as `owner/name`, lower case, so a declared one and the Cloud's compare alike. */
export function repositoryKey(source: unknown): string | undefined {
  const repository = repositoryOf(source);
  return repository && `${repository.owner}/${repository.name}`.toLowerCase();
}

/** A name made a slug: lower case, each run of other characters a dash. */
const slugged = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

/**
 * A host's slug, as a declaration gives it: its `name`, else the first label of `domains.app`,
 * else its repository's name, made a slug. Empty when it gives none of them.
 */
export function hostSlug(desired: { name?: unknown; source?: unknown; domains?: unknown }): string {
  if (typeof desired.name === "string" && desired.name) return desired.name;
  const app = (desired.domains as Record<string, unknown> | null | undefined)?.app;
  if (typeof app === "string" && app.includes(".")) return app.slice(0, app.indexOf("."));
  const repository = repositoryOf(desired.source);
  return repository ? slugged(repository.name) : "";
}

const slugField = z.string().regex(SLUG, "a slug: lower case letters, digits and dashes, 3 to 40 of them");

const databaseSchema = z.object({
  name: slugField
    .optional()
    .describe(
      "The company's slug, the host's own: by default the one Cloud company the token holds, which the host makes",
    ),
  region: z
    .enum(REGIONS)
    .optional()
    .describe("Where it runs, one of the Cloud's regions (`us-east` by default); it cannot move"),
  id: z.string().nullish().describe("The database's id at the Cloud, which it sets"),
  healthy: z.boolean().nullish().describe("Whether the Cloud says it is up"),
});

/** A database's fields: what the Cloud sets, and what it cannot change in place. */
const databaseFields = {
  immutable: ["name", "region"],
  vendorOwned: ["id", "healthy"],
  writeOnly: [],
} as const;

/**
 * `cloud.database({ region? })`: the company's database at Sanoma Cloud, a Neon project in the
 * Cloud's organization, which meets the `Database` contract: its compute pauses when quiet, and it
 * does not branch yet. The Cloud binds its URL to the company's host itself, so `storeUrl` stores
 * nothing. Its binding is the company's slug.
 */
export const database = defineResource({
  vendor: "cloud",
  type: "database",
  title: "Database",
  schema: databaseSchema,
  fields: databaseFields,
  bindingId: (state) => String(state.name),
  writable: true,
  // It holds the company's data: apply asks before it deletes one.
  stateless: false,
  database: {
    capabilities: { pauses: true, branch: false },
    inputs: { region: "region" },
    storeUrl: "cloud.database.storeUrl",
    regions: REGIONS,
    outputs: (state) => ({ healthy: state.healthy === true }),
  },
  afterCreate: [{ op: "cloud.database.storeUrl", input: ({ id, export: name }) => ({ id, export: name }) }],
});

const hostSchema = z.object({
  name: slugField
    .optional()
    .describe(
      "The company's slug, its address `<slug>.sanoma.work`: by default the first label of `domains.app`, else the repository's name",
    ),
  source: z.string().min(1).describe("The company repository's clone URL, or a declared GitHub repository"),
  ref: z.string().min(1).describe("The branch it runs, such as `main`, never a commit"),
  revision: z.string().nullish().describe("The commit it runs, which apply sets from `ref`"),
  port: z.literal(PORT).optional().describe(`The port the runtime listens on: the Cloud's, ${PORT}`),
  domains: z
    .record(z.string().regex(SITE_KEY), z.string().regex(DOMAIN_NAME))
    // Empty, it would read back as `<slug>.sanoma.work`, a change on every plan.
    .refine((domains) => Object.keys(domains).length > 0, "leave `domains` out rather than empty")
    .optional()
    .describe(
      "The company's address as `app` (`<slug>.sanoma.work`, the only one for now), which names its slug when `name` is left out",
    ),
  url: z.string().nullish().describe("Where the company answers, `https://<slug>.sanoma.work`, which the Cloud sets"),
  healthy: z.boolean().nullish().describe("Whether the Cloud says it runs"),
});

/** A host's fields: what the Cloud sets, and what it cannot change in place (a deploy moves only the revision). */
const hostFields = {
  immutable: ["name", "source", "ref", "port", "domains"],
  vendorOwned: ["url", "healthy"],
  writeOnly: [],
  references: { source: { type: "github.repository", by: ["http_clone_url"] } },
} as const;

/** A state or declaration with its `source` as `repositoryKey`. */
const sourceKey = (state: Record<string, unknown>) => {
  const key = repositoryKey(state.source);
  return key ? { ...state, source: key } : state;
};

/**
 * `cloud.host({ name?, source, ref, port?, domains? })`: the company's host at Sanoma Cloud, a
 * Worker and container in Sanoma's Cloudflare account at `<slug>.sanoma.work`, which meets the
 * `Host` contract: it stops when quiet and starts on the next request, its URL is public, and it
 * wakes itself through its own Worker's alarm. It binds its own bootstrap (the database URL, keys
 * and tokens are the Cloud's to mint and place), so it takes no `secrets`. A deploy moves it to
 * the revision apply resolves from `ref`; nothing else changes in place. Its binding is the slug.
 */
export const host = defineResource({
  vendor: "cloud",
  type: "host",
  title: "Host",
  identity: "name",
  schema: hostSchema,
  fields: hostFields,
  find: hostSlug,
  bindingId: (state) => String(state.name),
  // The Cloud knows the repository by its owner and name, not by the URL a declaration gives.
  normalize: (state, desired) => compareDeclared(hostFields, sourceKey(state), sourceKey(desired)),
  writable: true,
  host: {
    capabilities: { lifetime: "stops-when-quiet", publicUrl: true, buildsFromGit: false, staticEgress: false },
    bindsBootstrap: true,
    // `domains` is the type's own, not the contract's: its `app` is the company's address, no public site.
    inputs: { source: "source", ref: "ref", port: "port" },
    revision: "revision",
    outputs: (state) => ({
      url: String(state.url ?? ""),
      ...(typeof state.revision === "string" && { revision: state.revision }),
      healthy: state.healthy === true,
    }),
  },
});

/** `database.storeUrl`, in the database type's own group beside its resource operations. */
const storeUrlSpec = {
  storeUrl: {
    // It stores nothing and changes nothing: a read, so a create's policy sees no write for it.
    effect: "read",
    idempotent: true,
    description:
      "Store nothing: Sanoma Cloud binds the database's URL to the company's host itself, so no store here needs it",
    input: z.object({
      id: z.string().min(1).describe("The database's binding, the company's slug"),
      export: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .describe("The data file's export that declares the database, such as `store`"),
    }),
    output: z.object({
      stored: z.literal(false),
      reason: z.string().describe("Why nothing is stored"),
    }),
    target: ({ id }: { id: string }) => id,
  },
} satisfies Record<string, OpSpec>;

const types = defineConnector("cloud", { database, host }, vendorInfo(import.meta.url));
const store = defineConnector("cloud", { database: storeUrlSpec });

/** The connector's specs: both types' operations, and `storeUrl` in the database's group. */
type CloudSpecs = {
  database: (typeof database)["ops"] & typeof storeUrlSpec;
  host: (typeof host)["ops"];
};

/**
 * The connector's operations: each type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`) and `database.storeUrl` in the database's group (Supabase's pattern).
 */
export const cloudOps = {
  ...types,
  database: { ...types.database, ...store.database },
} as unknown as Connector<"cloud", CloudSpecs>;

/** The connector's type: both types, with `database.storeUrl`. */
export type CloudOps = typeof cloudOps;
