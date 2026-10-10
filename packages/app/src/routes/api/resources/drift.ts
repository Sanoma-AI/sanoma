import { createFileRoute } from "@tanstack/react-router";
import { json, startDrift } from "../../../server/core.ts";
import { withPrincipalRoute } from "../../../middleware.ts";

/** Starts a drift check of the resources the data files declare now, as the actor: 201 `{ runId }`. */
export const Route = createFileRoute("/api/resources/drift")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: {
          middleware: [withPrincipalRoute],
          handler: async ({ context }) => json(await startDrift(context.app, context.principal), 201),
        },
      }),
  },
});
