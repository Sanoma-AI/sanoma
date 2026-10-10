import { createFileRoute } from "@tanstack/react-router";
import { ClearCredentialRequest, SetCredentialRequest } from "../../api.ts";
import { clearCredential, credentials, json, parse, readJson, setCredential } from "../../server/core.ts";
import { withPrincipalRoute } from "../../middleware.ts";

/** Nothing to say: a change made, whose value is never sent back. */
const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/credentials")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        /** Each vendor's credential statuses now, never a value. */
        GET: async ({ context }) => json(await credentials(context.app)),
        /** Stores a declared variable's value as the actor: 204. */
        PUT: {
          middleware: [withPrincipalRoute],
          handler: async ({ request, context }) => {
            const body = parse(SetCredentialRequest, await readJson(request), 'Send {"name": variable, "value": text}');
            await setCredential(context.app, context.principal, body);
            return noContent();
          },
        },
        /** Deletes a declared variable's stored value as the actor: 204. */
        DELETE: {
          middleware: [withPrincipalRoute],
          handler: async ({ request, context }) => {
            const body = parse(ClearCredentialRequest, await readJson(request), 'Send {"name": variable}');
            await clearCredential(context.app, context.principal, body);
            return noContent();
          },
        },
      }),
  },
});
