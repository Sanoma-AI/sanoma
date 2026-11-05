import type { Client } from "@neon/sdk/raw";

/** `@neon/sdk`'s raw layer: Neon's endpoints one to one, without the ergonomic client's retries or readiness waits. */
export type Raw = typeof import("@neon/sdk/raw");

/**
 * The raw layer, loaded at the first call: a worker that never calls Neon (or the app listing the
 * connector) need not load it, and a test's replay, listening by then, sees its requests.
 */
export const loadSdk = (): Promise<Raw> => import("@neon/sdk/raw");

/**
 * A client of its own for `key`, which it sends as the Bearer token only: Neon's spec also lists
 * cookie schemes, which would otherwise carry the key too. Not the module's shared default client.
 */
export const neonClient = (raw: Raw, key: string): Client =>
  raw.createClient(
    raw.createConfig({
      baseUrl: "https://console.neon.tech/api/v2",
      auth: ({ scheme }) => (scheme === "bearer" ? key : undefined),
    }),
  );
