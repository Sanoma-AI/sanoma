import { tfConnector } from "@sanoma-ai/bridge/connector";
import { defineConnector } from "@sanoma-ai/workflows";
import { z } from "zod";
import { provider, supabase_project } from "./resources.gen.ts";

/**
 * Supabase's bolt, from simple-icons (https://simpleicons.org/?q=supabase, CC0), in Supabase's
 * green, which reads on light and dark backgrounds alike.
 */
const bolt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#3FCF8E" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/></svg>`;

/**
 * Supabase, through the `supabase/supabase` OpenTofu provider: the generated resource types, and
 * who Supabase is. Supabase names its projects (a project's ref), so a declaration has no
 * identity: its project is the one its binding names, by its ref. The provider answers a project
 * that does not exist with the state it was given, so one without a name is gone. Apply creates,
 * changes and deletes projects. The resource types, the data-file constructors and the
 * provider's driver come from this one record; `supabaseOps` adds the Management API operations.
 */
export const supabaseTf = tfConnector({
  vendor: "supabase",
  provider,
  types: {
    project: { tf: supabase_project, title: "Project", exists: (state) => state.name != null, writable: true },
  },
  info: {
    title: "Supabase",
    logo: { svg: bolt },
    package: "@sanoma-ai/connector-supabase",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/supabase#readme",
  },
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
        "Store a project's database URL, through its session pooler with the password in SUPABASE_DB_PASSWORD, as the secret SANOMA_DATABASE_URL_<EXPORT>; kept when one is stored, and never returned",
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
} as typeof supabaseTf.connector & typeof management;
