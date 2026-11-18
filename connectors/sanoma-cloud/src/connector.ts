import {
  compareDeclared,
  type Connector,
  defineConnector,
  defineResource,
  type OpSpec,
  vendorInfo,
} from "sanoma/workflows";
import { CLOUD_HOSTNAME, CLOUD_SLUG, CLOUD_SLUG_RULE } from "sanoma/workflows/shared";
import { z } from "zod";

/*
 * Sanoma Cloud: the company's database and host in Sanoma's own accounts, a vendor the company's
 * repository declares like any other. Its API is sanoma-ops's workflows (`cloud-signup`,
 * `cloud-list`, `cloud-deploy`, `cloud-close`, and for going live from a computer
 * `cloud-available` and `cloud-invite`), started over the public api of www.sanoma.work with the
 * company's Cloud token; the schemas are a cut of their fields, by hand. The company is the
 * token's (one token, one company), an id that never changes, which the lockfile binds the
 * database and the host to; its address is the host's `hostname`, which a deploy can change.
 */

/**
 * The regions a Cloud database takes, each a Neon region in the Cloud's organization, as
 * sanoma-ops's `cloud-signup` maps them: AWS us-east-1, us-west-2, eu-central-1, eu-west-2, ap-southeast-1.
 */
export const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-southeast"] as const;

/** A company's slug (`CLOUD_SLUG`), its address `<slug>.sanoma.work`, in words. */
const SLUG_RULE = `a slug: ${CLOUD_SLUG_RULE}`;

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

const slugField = z.string().regex(CLOUD_SLUG, SLUG_RULE);

/** The company's id at the Cloud, which the Cloud sets and the lockfile binds: the database's and the host's alike. */
const companyId = z.string().nullish().describe("The company's id at the Cloud, which it sets: it never changes");

const databaseSchema = z.object({
  region: z
    .enum(REGIONS)
    .optional()
    .describe("Where it runs, one of the Cloud's regions (`us-east` by default); it cannot move"),
  id: companyId,
  healthy: z.boolean().nullish().describe("Whether the Cloud says it is up"),
});

/** A database's fields: what the Cloud sets, and what it cannot change in place. */
const databaseFields = {
  immutable: ["region"],
  vendorOwned: ["id", "healthy"],
  writeOnly: [],
} as const;

/**
 * `cloud.database({ region? })`: the company's database at Sanoma Cloud, a Neon project in the
 * Cloud's organization, which meets the `Database` contract: its compute pauses when quiet, and it
 * does not branch yet. It has no name: the Cloud token is for one company, and that company's is
 * the database. The Cloud binds its URL to the company's host itself, so `storeUrl` stores
 * nothing. Its binding is the company's id.
 */
export const database = defineResource({
  vendor: "cloud",
  type: "database",
  title: "Database",
  schema: databaseSchema,
  fields: databaseFields,
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
  hostname: z
    .string()
    .regex(CLOUD_HOSTNAME, `<slug>.sanoma.work, the slug ${CLOUD_SLUG_RULE}`)
    .describe("The company's address, `<slug>.sanoma.work` (the only kind for now): a change renames the company"),
  // Optional to the schema alone: a write-only field, which apply leaves out of what it plans (`withoutWriteOnly`).
  // The Cloud makes no host for a company without its database, and refuses one.
  database: z
    .string()
    .min(1)
    .optional()
    .describe("The declared Cloud database it runs on, such as `store`: the Cloud binds its URL to the host itself"),
  source: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The company repository, an override: by default the one the app runs from (its `origin`, or the GitHub repository its data file declares)",
    ),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("The branch it runs, an override: by default the repository's default branch"),
  revision: z.string().nullish().describe("The commit it runs, which apply sets from `ref`"),
  port: z.literal(PORT).optional().describe(`The port the runtime listens on: the Cloud's, ${PORT}; never declared`),
  id: companyId,
  url: z.string().nullish().describe("Where the company answers, `https://<hostname>`, which the Cloud sets"),
  healthy: z.boolean().nullish().describe("Whether the Cloud says it runs"),
});

/** A host's fields: what the Cloud sets, and what it cannot change in place (a deploy moves the revision and the address). */
const hostFields = {
  immutable: ["source", "ref", "port"],
  vendorOwned: ["id", "url", "healthy"],
  writeOnly: ["database"],
  references: {
    source: { type: "github.repository", by: ["http_clone_url"] },
    database: { type: "cloud.database" },
  },
} as const;

/** A state or declaration with its `source` as `repositoryKey`. */
const sourceKey = (state: Record<string, unknown>) => {
  const key = repositoryKey(state.source);
  return key ? { ...state, source: key } : state;
};

/**
 * `cloud.host({ hostname, database })`: the company's host at Sanoma Cloud, a Worker and
 * container in Sanoma's Cloudflare account at its `hostname`, `<slug>.sanoma.work`, which meets
 * the `Host` contract: it ends with its process once its worker is idle and starts on the next
 * wake, its URL is public, and it wakes itself through its own Worker's alarm. It binds its own
 * bootstrap (the database URL, keys and tokens are the Cloud's to mint and place), so it takes no
 * `secrets`. Apply gives it the repository the app runs from (`source`, an override) and that
 * repository's default branch (`ref`, an override), as `cloudflare.host`; its port is the
 * Cloud's. A deploy moves it to the revision apply resolves from `ref`, and to another `hostname`
 * (a rename); nothing else changes in place. Its binding is the company's id, as the database's.
 */
export const host = defineResource({
  vendor: "cloud",
  type: "host",
  title: "Host",
  schema: hostSchema,
  fields: hostFields,
  // The Cloud knows the repository by its owner and name, not by the URL a declaration gives.
  normalize: (state, desired) => compareDeclared(hostFields, sourceKey(state), sourceKey(desired)),
  writable: true,
  host: {
    capabilities: { lifetime: "stops-on-exit", publicUrl: true, buildsFromGit: false, staticEgress: false },
    bindsBootstrap: true,
    derives: true,
    inputs: { source: "source", ref: "ref", hostname: "hostname", database: "database" },
    account: {
      repository: "cloud.company.repository",
      available: "cloud.company.available",
      invite: "cloud.company.invite",
    },
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
      id: z.string().min(1).describe("The database's binding, the company's id"),
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

/**
 * The account's operations, which going live from a computer calls (the host's `account`): whether
 * an address is free, the company's repository made by the Sanoma.work GitHub App, and a one-use
 * link that signs the account's own email in on the company's host. The company is the token's
 * (one token, one company); only a token that has none yet names its address, for the repository.
 */
const companySpecs = {
  available: {
    effect: "read",
    idempotent: true,
    description:
      "Whether the address <slug>.sanoma.work is free, or already the account's own company (cloud-available)",
    input: z.object({ slug: slugField.describe("The company's slug") }),
    output: z.object({
      available: z.boolean().describe("Nobody holds it: going live takes it"),
      yours: z.boolean().describe("The token's account holds it already"),
    }),
    target: ({ slug }: { slug: string }) => slug,
  },
  repository: {
    effect: "write",
    // Made once: a retry finds the one made.
    idempotent: true,
    description:
      "Make the token's company's repository, empty, with the Sanoma.work GitHub App in the account it is installed on, unless it has one (cloud-signup, part repository); its owner and name",
    input: z.object({
      slug: slugField.describe("The address a new company takes, while the token has none: `<slug>.sanoma.work`"),
    }),
    output: z.object({
      owner: z.string().regex(/^[\w-]+$/, "a GitHub owner"),
      name: z.string().regex(/^(?!\.\.?$)[\w.-]+$/, "a GitHub repository's name"),
    }),
    target: ({ slug }: { slug: string }) => slug,
  },
  invite: {
    effect: "access",
    // Each try mints another link, and the host's newest for an email replaces the last.
    idempotent: true,
    description:
      "A one-use link that signs the account's own email in on the token's company's host, minted by the Cloud (cloud-invite)",
    input: z.object({ email: z.email() }),
    output: z.object({ url: z.string().describe("The one-use invite link") }),
    // A link that signs someone in: the ledger records that there was one, not what it was.
    opaque: ["url"],
  },
} satisfies Record<string, OpSpec>;

const types = defineConnector("cloud", { database, host }, vendorInfo(import.meta.url));
const store = defineConnector("cloud", { database: storeUrlSpec, company: companySpecs });

/** The connector's specs: both types' operations, `storeUrl` in the database's group, and the account's. */
type CloudSpecs = {
  database: (typeof database)["ops"] & typeof storeUrlSpec;
  host: (typeof host)["ops"];
  company: typeof companySpecs;
};

/**
 * The connector's operations: each type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`), `database.storeUrl` in the database's group (Supabase's pattern), and the account's
 * (`company.available`, `.repository`, `.invite`).
 */
export const cloudOps = {
  ...types,
  database: { ...types.database, ...store.database },
  company: store.company,
} as unknown as Connector<"cloud", CloudSpecs>;

/** The connector's type: both types, with `database.storeUrl`. */
export type CloudOps = typeof cloudOps;
