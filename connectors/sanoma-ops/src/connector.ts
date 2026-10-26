import { type Connector, defineConnector, defineResource, type OpSpec, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/*
 * sanoma-ops's wakeup service (`sanoma wakeup`, `@sanoma-ai/workflows/wakeup-service`): an
 * instance of it wakes one stopped company instance, calling `GET {host}/wake?generation=N` at
 * the time the company's worker registered before it stopped. The service has no SDK or OpenAPI
 * spec, so the schemas are a cut of its own JSON, by hand.
 */

/**
 * The host types a wakeup may name: each one a data file declares a wakeup for. A new host type
 * is added here. `testhost.app` is `@sanoma-ai/testing`'s, for the conformance kits.
 */
const HOSTS = ["docker.container", "testhost.app"] as const;

/** An instance of the wakeup service, as `GET /wakeup/instances/{id}` shows it. */
const wakeupSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("The host's URL, which the service calls `/wake` under: a data file names the host's declaration"),
  id: z.string().optional().describe("The instance's id at the service"),
  at: z.string().nullable().optional().describe("When the instance asked to be woken last, null until it has"),
  generation: z.number().int().optional().describe("The generation of that registration, 0 until one"),
  lastError: z
    .string()
    .nullable()
    .optional()
    .describe("Why the last call to the host's `/wake` failed, null when it answered"),
});

/**
 * `sanomaOps.wakeup({ host })`: an instance of sanoma-ops's wakeup service for the host a data
 * file names, which it calls at the time the worker registers (`wakeup.register`). The service
 * names it, so a declaration has no identity: its binding is its id. Apply creates it with the
 * account's token (`SANOMA_OPS_TOKEN`) and stores the instance's own token, shown once, as
 * `SANOMA_WAKEUP_TOKEN`; a new host is a new instance.
 */
export const wakeup = defineResource({
  vendor: "sanomaOps",
  type: "wakeup",
  title: "Wakeup",
  schema: wakeupSchema,
  fields: {
    immutable: ["host"],
    vendorOwned: ["id", "at", "generation", "lastError"],
    writeOnly: [],
    references: { host: { type: HOSTS, by: ["url"] } },
  },
  writable: true,
  // One made again has a new token, which cannot replace the one stored: apply asks first.
  stateless: false,
  wakeup: {
    inputs: { host: "host" },
    register: "sanomaOps.wakeup.register",
    outputs: (state) => ({ healthy: typeof state.id === "string" && state.lastError == null }),
  },
});

const types = defineConnector("sanomaOps", { wakeup }, vendorInfo(import.meta.url));

/** `wakeup.register`, in the wakeup type's own group, beside its resource operations. */
const registerSpec = {
  register: {
    effect: "write",
    // The service applies a generation only when it is newer: a retry changes nothing.
    idempotent: true,
    description:
      "Ask the wakeup service to call the host's /wake at `at` with `generation`, replacing the wake registered before",
    input: z.object({
      id: z.string().min(1).describe("The instance's id at the service, its binding"),
      at: z.iso.datetime({ offset: true }).describe("When to wake the host, ISO 8601"),
      generation: z.number().int().min(1).describe("Counts up from 1: only a newer one replaces the wake"),
    }),
    output: z.object({}),
    target: ({ id }: { id: string }) => id,
  },
} satisfies Record<string, OpSpec>;

const register = defineConnector("sanomaOps", { wakeup: registerSpec });

/** The connector's specs: the wakeup type's operations and `register` in one group. */
type SanomaOpsSpecs = { wakeup: (typeof wakeup)["ops"] & typeof registerSpec };

/**
 * The connector's operations: the wakeup type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`) and `wakeup.register` in its group (Supabase's pattern).
 */
export const sanomaOpsOps = {
  ...types,
  wakeup: { ...types.wakeup, ...register.wakeup },
} as unknown as Connector<"sanomaOps", SanomaOpsSpecs>;

/** The connector's type: the wakeup type with `wakeup.register`. */
export type SanomaOpsOps = typeof sanomaOpsOps;
