import { defineAuthentication, SecretStoreError } from "@sanoma-ai/workflows";
import { z } from "zod";
import { loadSdk, neonClient } from "./sdk.ts";

/** An organization key: Neon verifies which organization owns it before every invocation. */
export const neonApiKey = defineAuthentication({
  kind: "api-key",
  version: 1,
  schema: z.object({ apiKey: z.string().min(1).describe("An organization API key from Neon organization settings") }),
  storage: { writable: false, conditionalWrites: false, maxBytes: 8192 },
  async verify({ apiKey }) {
    // Organization- and project-scoped keys return only the organization that owns the key.
    // https://api-docs.neon.tech/reference/getcurrentuserorganizations
    let id: string | undefined;
    try {
      const raw = await loadSdk();
      const { data, error } = await raw.getCurrentUserOrganizations({
        client: neonClient(raw, apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (error === undefined && data.organizations?.length === 1) id = data.organizations[0]?.id;
    } catch {
      // A failure to load or to send is a key not verified.
    }
    if (!id) throw new SecretStoreError("denied");
    // This endpoint does not attest individual API scopes or key expiry. Do not invent grants.
    return { account: id, scopes: [] };
  },
});
