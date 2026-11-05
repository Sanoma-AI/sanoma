import { defineAuthentication, SecretStoreError } from "@sanoma-ai/workflows";
import type { Client } from "@neon/sdk/raw";
import { z } from "zod";

/**
 * A client of `@neon/sdk`'s raw layer that sends `key` as the Bearer token only: Neon's spec also
 * lists cookie schemes, which would otherwise carry the key too.
 */
export const neonClient = (raw: typeof import("@neon/sdk/raw"), key: string): Client =>
  raw.createClient({ ...raw.client.getConfig(), auth: ({ scheme }) => (scheme === "bearer" ? key : undefined) });

/** An organization key: Neon verifies which organization owns it before every invocation. */
export const neonApiKey = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.object({ apiKey: z.string().min(1).describe("An organization API key from Neon organization settings") }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 8192 },
  async verify({ apiKey }) {
    // Organization- and project-scoped keys return only the organization that owns the key.
    // https://api-docs.neon.tech/reference/getcurrentuserorganizations
    try {
      const raw = await import("@neon/sdk/raw");
      const { data, error } = await raw.getCurrentUserOrganizations({
        client: neonClient(raw, apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      const id = error === undefined && data.organizations?.length === 1 ? data.organizations[0]?.id : undefined;
      if (!id) throw new SecretStoreError("denied");
      // This endpoint does not attest individual API scopes or key expiry. Do not invent grants.
      return { account: id, scopes: [] };
    } catch {
      throw new SecretStoreError("denied");
    }
  },
});
