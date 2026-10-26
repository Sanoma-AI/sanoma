import { type Connector, defineConnector, defineResource, type OpSpec, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/*
 * Neon, serverless Postgres (https://api-docs.neon.tech/reference), through its official SDK,
 * `@neondatabase/api-client`. The schemas are a cut of Neon's own field names, by hand.
 */

/** Neon's AWS regions, as a project's `region` takes them (https://neon.com/docs/introduction/regions). */
export const REGIONS = [
  "aws-us-east-1",
  "aws-us-east-2",
  "aws-us-west-2",
  "aws-eu-central-1",
  "aws-eu-west-2",
  "aws-ap-southeast-1",
  "aws-ap-southeast-2",
  "aws-sa-east-1",
] as const;

/** A project as the operations read it: what a data file declares, and what Neon sets. */
const projectSchema = z.object({
  name: z.string().min(1).max(256).describe("The project's name: Neon's id names it, so two may share one"),
  region: z.string().min(1).describe("Where it runs, a Neon region id such as `aws-us-east-1`; it cannot move"),
  size: z
    .string()
    .regex(/^\d+(\.\d+)?(-\d+(\.\d+)?)?$/, "a size in compute units, such as `0.25`, or a range such as `0.25-2`")
    .optional()
    .describe(
      "Its compute's size in compute units (CU), such as `0.25` (the default), or `min-max` to autoscale between them",
    ),
  pg_version: z.number().int().min(14).optional().describe("The major Postgres version, Neon's default when unset"),
  id: z.string().optional().describe("The project's id at Neon"),
  host: z.string().optional().describe("Its default compute's host, which the direct URL connects to"),
  default_branch_id: z.string().optional().describe("The id of its default branch, which holds the company's data"),
  default_endpoint_id: z.string().optional().describe("The id of the default branch's read-write compute"),
  healthy: z.boolean().optional().describe("Whether its default compute has started once: active, or idle (paused)"),
});

/** The compute's autoscaling limits a declared `size` gives: one size for both, or a range. */
export function limitsOf(size = "0.25"): { autoscaling_limit_min_cu: number; autoscaling_limit_max_cu: number } {
  const [min, max = min] = size.split("-").map(Number) as [number, number?];
  return { autoscaling_limit_min_cu: min, autoscaling_limit_max_cu: max };
}

/** A compute's `size` as its limits read: one number when they are the same, else `min-max`. */
export const sizeOf = (min: number, max: number) => (min === max ? String(min) : `${min}-${max}`);

/**
 * `neon.project({ name, region, size?, pg_version? })`: a Neon project, the company's database,
 * which meets the `Database` contract: its compute pauses after five minutes without queries and
 * wakes on the next connection, and it branches (`neon.branch.create`). Neon names projects, so a
 * declaration has no identity: its binding is the project's id. Apply creates it, then waits for
 * its default compute (`project.health`) and stores its direct URL (`project.storeUrl`).
 */
export const project = defineResource({
  vendor: "neon",
  type: "project",
  title: "Project",
  schema: projectSchema,
  fields: {
    immutable: ["region", "pg_version"],
    vendorOwned: ["id", "host", "default_branch_id", "default_endpoint_id", "healthy"],
    writeOnly: [],
  },
  writable: true,
  // It holds the company's data: apply asks before it deletes one.
  stateless: false,
  database: {
    capabilities: { pauses: true, branch: true },
    inputs: { region: "region", size: "size" },
    storeUrl: "neon.project.storeUrl",
    regions: REGIONS,
    outputs: (state) => ({ healthy: state.healthy === true }),
  },
  afterCreate: [
    { op: "neon.project.health", input: ({ id }) => ({ id }), until: (out) => out?.healthy === true },
    { op: "neon.project.storeUrl", input: ({ id, export: name }) => ({ id, export: name }) },
  ],
});

const projectId = z.string().min(1).describe("The project's id at Neon");
const objectId = z.string().min(1);

/** What the project type's group adds beside its resource operations. */
const projectSpecs = {
  health: {
    effect: "read",
    idempotent: true,
    description: "Read whether a project's default compute has started: active, or idle (paused) after it ran",
    input: z.object({ id: projectId }),
    output: z.object({
      healthy: z.boolean(),
      state: z.string().describe("The default compute's state: `init`, `active` or `idle`"),
    }),
    target: ({ id }: { id: string }) => id,
  },
  storeUrl: {
    effect: "write",
    idempotent: true,
    description:
      "Store a project's direct (unpooled) database URL as the secret SANOMA_DATABASE_URL_<EXPORT>, never returned; refused when that secret holds another URL",
    input: z.object({
      id: projectId,
      export: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .describe("The data file's export that declares the project, such as `store`"),
    }),
    output: z.object({ secret: z.string().describe("The secret's name, SANOMA_DATABASE_URL_<EXPORT>") }),
    target: ({ id }: { id: string }) => id,
  },
} satisfies Record<string, OpSpec>;

const branchTarget = (input: { project: string; id?: string }) =>
  input.id ? `${input.project}/${input.id}` : input.project;
const endpointTarget = (input: { project: string; id: string }) => `${input.project}/${input.id}`;
const endpointInput = z.object({ project: projectId, id: objectId.describe("The compute's id (`ep-…`)") });

/** A branch of a project, for previews, and a compute's suspend and start. */
const specs = {
  branch: {
    create: {
      effect: "write",
      description:
        "Create a copy-on-write branch of a project's default branch, with its data and a read-write compute; returns its direct URL, once",
      input: z.object({
        project: projectId,
        name: z.string().min(1).max(256).describe("The branch's name"),
        expiresAt: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("When Neon deletes the branch by itself, RFC 3339 to the second"),
      }),
      output: z.object({
        id: z.string().describe("The branch's id (`br-…`)"),
        url: z.string().describe("Its direct database URL, with the role's password: returned this once"),
      }),
      // Its URL carries a password: the ledger records it by name only.
      opaque: ["url"],
      target: branchTarget,
    },
    delete: {
      effect: "write",
      idempotent: true,
      description: "Delete a branch of a project and its computes; done already when it is gone",
      input: z.object({ project: projectId, id: objectId.describe("The branch's id (`br-…`)") }),
      output: z.object({ id: z.string(), gone: z.literal(true) }),
      target: branchTarget,
    },
  },
  endpoint: {
    suspend: {
      effect: "write",
      idempotent: true,
      description: "Suspend a compute now, dropping its connections; the next connection wakes it",
      input: endpointInput,
      output: z.object({ state: z.string() }),
      target: endpointTarget,
    },
    start: {
      effect: "write",
      idempotent: true,
      description: "Start a suspended compute",
      input: endpointInput,
      output: z.object({ state: z.string() }),
      target: endpointTarget,
    },
  },
} satisfies Record<string, Record<string, OpSpec>>;

const types = defineConnector("neon", { project }, vendorInfo(import.meta.url));
const more = defineConnector("neon", { project: projectSpecs, ...specs });

/** The connector's specs: the project type's operations and `health` and `storeUrl` in one group, then branches and computes. */
type NeonSpecs = { project: (typeof project)["ops"] & typeof projectSpecs } & typeof specs;

/**
 * The connector's operations: the project type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`) with `project.health` and `project.storeUrl` in its group (Supabase's pattern),
 * `branch.create` and `branch.delete`, and `endpoint.suspend` and `endpoint.start`.
 */
export const neonOps = {
  // `types` last: its vendor (who Neon is, and its resource types) is the connector's.
  ...more,
  ...types,
  project: { ...types.project, ...more.project },
} as unknown as Connector<"neon", NeonSpecs>;

/** The connector's type. */
export type NeonOps = typeof neonOps;
