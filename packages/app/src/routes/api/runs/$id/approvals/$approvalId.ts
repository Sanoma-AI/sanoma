import { createFileRoute } from "@tanstack/react-router";
import { DecideRequest } from "../../../../../api.ts";
import { decide, json, parse, readJson, requireActor } from "../../../../../server/core.ts";

/** Decides an approval as the actor; answers with the approval's state. */
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
        return json(await decide(context.app, actor, { ...body, runId: params.id, approvalId: params.approvalId }));
      },
    },
  },
});
