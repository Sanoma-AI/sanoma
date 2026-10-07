import { createFileRoute } from "@tanstack/react-router";
import { json, respond, runDetail } from "../../../../server/core.ts";

/** One run: `{ run, ledger, ledgerError?, approvals }`. */
export const Route = createFileRoute("/api/runs/$id/")({
  server: {
    handlers: {
      GET: ({ params }) => respond("GET /api/runs/:id", async () => json(await runDetail(params.id))),
    },
  },
});
