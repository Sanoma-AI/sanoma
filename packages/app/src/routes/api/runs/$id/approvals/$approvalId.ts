import { createFileRoute } from "@tanstack/react-router";
import { DecideRequest } from "../../../../../api.ts";
import { decide, json, parse, readJson } from "../../../../../server/core.ts";
import { withPrincipalRoute } from "../../../../../middleware.ts";

/**
 * Decides an approval as the actor; answers with the approval's state: 200 once the run read
 * the decision, 202 while it is still `pending` (see `DecideRequest`).
 */
export const Route = createFileRoute("/api/runs/$id/approvals/$approvalId")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: {
          middleware: [withPrincipalRoute],
          handler: async ({ request, params, context }) => {
            const body = parse(
              DecideRequest,
              await readJson(request),
              'Send {"decision": "approve" | "reject", "note"?: string}',
            );
            const call = { ...body, runId: params.id, approvalId: params.approvalId };
            const state = await decide(context.app, context.principal, call);
            return json(state, state.status === "pending" ? 202 : 200);
          },
        },
      }),
  },
});
