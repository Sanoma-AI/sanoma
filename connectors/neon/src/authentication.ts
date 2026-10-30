import { defineAuthentication, SecretStoreError } from "@sanoma-ai/workflows";
import { z } from "zod";

/** An organization key: Neon verifies which organization owns it before every invocation. */
export const neonApiKey = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.object({ apiKey: z.string().min(1).describe("An organization API key from Neon organization settings") }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 8192 },
  async verify({ apiKey }) {
    // Organization- and project-scoped keys return only the organization that owns the key.
    // https://api-docs.neon.tech/reference/getcurrentuserorganizations
    const { createApiClient } = await import("@neondatabase/api-client");
    const client = createApiClient({ apiKey, timeout: 10_000 });
    try {
      const { data } = await client.getCurrentUserOrganizations();
      if (data.organizations.length !== 1 || !data.organizations[0]?.id) throw new SecretStoreError("denied");
      // This endpoint does not attest individual API scopes or key expiry. Do not invent grants.
      return { account: data.organizations[0].id, scopes: [] };
    } catch {
      throw new SecretStoreError("denied");
    }
  },
});
