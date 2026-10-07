import { createFileRoute } from "@tanstack/react-router";
import { DecideRequest } from "../../../../../api.ts";
import { getApp } from "../../../../../server/app.ts";
import { decide, json, parse, readJson, requireActor, respond } from "../../../../../server/core.ts";

/** Decides an approval as the actor; answers with the approval's state. */
export const Route = createFileRoute("/api/runs/$id/approvals/$approvalId")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        respond("POST /api/runs/:id/approvals/:approvalId", async () => {
          const actor = await requireActor(getApp(), request);
          const body = parse(
            DecideRequest,
            await readJson(request),
            'Send {"decision": "approve" | "reject", "note"?: string}',
          );
          return json(await decide(actor, { ...body, runId: params.id, approvalId: params.approvalId }));
        }),
    },
  },
});
