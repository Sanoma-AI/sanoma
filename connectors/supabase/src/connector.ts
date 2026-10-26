import { tfConnector } from "@sanoma-ai/bridge/connector";
import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";
import { provider, supabase_project } from "./resources.gen.ts";

/** Supabase's regions, as a project's `region` takes them. */
const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
] as const;

/**
 * Supabase, through the `supabase/supabase` OpenTofu provider: the generated resource types, and
 * who Supabase is. Supabase names its projects (a project's ref), so a declaration has no
 * identity: its project is the one its binding names, by its ref. The provider answers a project
 * that does not exist with the state it was given, so one without a name is gone. Apply creates,
 * changes and deletes projects. The resource types, the data-file constructors and the
 * provider's driver come from this one record; `supabaseOps` adds the Management API operations,
 * two of which apply calls after it creates a project.
 */
export const supabaseTf = tfConnector({
  vendor: "supabase",
  provider,
  types: {
    project: {
      tf: supabase_project,
      title: "Project",
      exists: (state) => state.name != null,
      writable: true,
      // The company's database: it does not pause as the contract means (a paid project never
      // does; a free one that pauses wakes on a restore, not on a connection), and a branch starts empty.
      database: {
        capabilities: { pauses: false, branch: false },
        inputs: { region: "region" },
        storeUrl: "supabase.database.storeUrl",
        regions: REGIONS,
        outputs: (state) => ({ healthy: state.name != null }),
      },
      // Once apply makes a project: its database and pooler healthy, then the URL a worker
      // connects with stored as SANOMA_DATABASE_URL_<EXPORT>, which a host's secrets name.
      afterCreate: [
        { op: "supabase.project.health", input: ({ id }) => ({ ref: id }), until: (out) => out?.healthy === true },
        { op: "supabase.database.storeUrl", input: ({ id, export: name }) => ({ ref: id, export: name }) },
      ],
    },
  },
  info: vendorInfo(import.meta.url),
});

const projectRef = z.string().min(1).describe("The project's ref");
const target = ({ ref }: { ref: string }) => ref;

/**
 * What the provider's project does not carry, from Supabase's Management API: the session
 * pooler's address, the project's health, and the database URL a worker connects with, which
 * only the secrets store ever holds.
 */
const management = defineConnector("supabase", {
  pooler: {
    get: {
      effect: "read",
      idempotent: true,
      description: "Read the address of a project's session pooler (port 5432), which keeps LISTEN, unlike port 6543",
      input: z.object({ ref: projectRef }),
      output: z.object({ host: z.string(), port: z.literal(5432), user: z.string(), database: z.string() }),
      target,
    },
  },
  project: {
    health: {
      effect: "read",
      idempotent: true,
      description: "Read whether a project's services are healthy: its database and pooler unless others are named",
      input: z.object({ ref: projectRef, services: z.array(z.string().min(1)).min(1).optional() }),
      output: z.object({
        healthy: z.boolean(),
        services: z.array(z.object({ name: z.string(), healthy: z.boolean(), status: z.string() })),
      }),
      target,
    },
  },
  database: {
    storeUrl: {
      effect: "write",
      idempotent: true,
      description:
        "Store a project's database URL, through its session pooler with the password in SUPABASE_DB_PASSWORD, as the secret SANOMA_DATABASE_URL_<EXPORT>, never returned; refused when that secret holds another URL",
      input: z.object({
        ref: projectRef,
        export: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .describe("The data file's export that declares the project, such as `store`"),
      }),
      output: z.object({ secret: z.string().describe("The secret's name, SANOMA_DATABASE_URL_<EXPORT>") }),
      target,
    },
  },
});

/**
 * The Supabase connector's operations: the project type's (`read`, `import`, `plan`, `create`,
 * `update`, `delete`) and the Management API's (`project.health`, `pooler.get`,
 * `database.storeUrl`).
 */
export const supabaseOps = {
  ...supabaseTf.connector,
  project: { ...supabaseTf.connector.project, ...management.project },
  pooler: management.pooler,
  database: management.database,
} as SupabaseOps;

/** The Supabase connector's type: the provider's resource types with the Management API operations. */
export type SupabaseOps = typeof supabaseTf.connector & typeof management;
