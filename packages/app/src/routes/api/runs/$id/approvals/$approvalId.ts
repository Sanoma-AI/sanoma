import { createFileRoute } from "@tanstack/react-router";
import { DecideRequest } from "../../../../../api.ts";
import { decide, json, parse, readJson, requireActor } from "../../../../../server/core.ts";

/**
 * Decides an approval as the actor; answers with the approval's state: 200 once the run read
 * the decision, 202 while it is still `pending` (see `DecideRequest`).
 */
export const Route = createFileRoute("/api/runs/$id/approvals/$approvalId")({
  server: {
    handlers: {
      POST: async ({ request, params, context }) => {
        const actor = requireActor(context);
        const body = parse(
          DecideRequest,
          await readJson(request),
          'Send {"decision": "approve" | "reject", "note"?: string}',
        );
        const state = await decide(context.app, actor, { ...body, runId: params.id, approvalId: params.approvalId });
        return json(state, state.status === "pending" ? 202 : 200);
      },
    },
  },
});
