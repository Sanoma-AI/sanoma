import { z } from "zod";
import { type Connector, defineConnector, type OpSpec } from "./op.ts";
import { SANOMA_INFO } from "./person.ts";
import { defineResource } from "./resource.ts";

// The runtime's own wakeup, `sanoma.wakeup({ host })`: an instance of a wakeup service (`sanoma
// wakeup`, `wakeup-service.ts`: sanoma-ops's, or one of the company's own) that calls the host's
// `GET /wake` at the time the worker registered before it stopped. The fallback for a host with no
// clock of its own; every config with a host type has it (`resolveConfig`), so no connector is
// needed. Its driver is `wakeup-driver.ts`, its fake `fakeSanomaWakeup` in `fake.ts`, and `config.ts`
// puts them together as `sanomaWakeup`. The service has no SDK or OpenAPI spec, so
// the schemas are a cut of its own JSON, by hand.

/**
 * The host types a wakeup may name: each one a data file declares a wakeup for. A new host type
 * is added here. `testhost.app` is `@sanoma-ai/testing`'s, for the conformance kits.
 */
const HOSTS = ["cloudflare.container", "docker.container", "testhost.app"] as const;

/** An instance of the wakeup service, as `GET /wakeup/instances/{id}` shows it. */
const wakeupSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("The host's URL, which the service calls `/wake` under: a data file names the host's declaration"),
  id: z.string().optional().describe("The instance's id at the service"),
  at: z.string().nullable().optional().describe("When the instance asked to be woken last, null until it has"),
  lastError: z
    .string()
    .nullable()
    .optional()
    .describe("Why the last call to the host's `/wake` failed, null when it answered"),
});

/**
 * `sanoma.wakeup({ host })`: an instance of a wakeup service for the host a data file names,
 * which it calls at the time the worker registers (`sanoma.wakeup.register`). The service names
 * it, so a declaration has no identity: its binding is its id. Apply creates it with the
 * account's token (`SANOMA_WAKEUP_ACCOUNT_TOKEN`) and the instance's own, `SANOMA_WAKEUP_TOKEN`,
 * which the company minted (`/setup`) and which names the instance: a new host is the same
 * instance moved.
 */
export const wakeup = defineResource({
  vendor: "sanoma",
  type: "wakeup",
  title: "Wakeup",
  schema: wakeupSchema,
  fields: {
    immutable: [],
    vendorOwned: ["id", "at", "lastError"],
    writeOnly: [],
    references: { host: { type: HOSTS, by: ["url"] } },
  },
  writable: true,
  // The service holds its registered wake: apply asks before it deletes one.
  stateless: false,
  wakeup: {
    inputs: { host: "host" },
    register: "sanoma.wakeup.register",
    outputs: (state) => ({ healthy: typeof state.id === "string" && state.lastError == null }),
  },
});

const types = defineConnector("sanoma", { wakeup }, SANOMA_INFO);

/** `wakeup.register`, in the wakeup type's own group, beside its resource operations. */
const registerSpec = {
  register: {
    effect: "write",
    // Each replaces the wake registered before: a retry changes nothing.
    idempotent: true,
    description: "Ask the wakeup service to call the host's /wake at `at`, replacing the wake registered before",
    input: z.object({ at: z.iso.datetime({ offset: true }).describe("When to wake the host, ISO 8601") }),
    output: z.object({}),
  },
} satisfies Record<string, OpSpec>;

const register = defineConnector("sanoma", { wakeup: registerSpec });

/** The wakeup's specs: the type's operations and `register` in one group. */
type WakeupSpecs = { wakeup: (typeof wakeup)["ops"] & typeof registerSpec };

/**
 * The wakeup's operations: the type's (`read`, `import`, `plan`, `create`, `update`, `delete`)
 * and `sanoma.wakeup.register` in its group (Supabase's pattern).
 */
export const wakeupOps = {
  ...types,
  wakeup: { ...types.wakeup, ...register.wakeup },
} as unknown as Connector<"sanoma", WakeupSpecs>;
