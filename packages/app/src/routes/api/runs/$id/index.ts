import { createFileRoute } from "@tanstack/react-router";
import { json, runDetail } from "../../../../server/core.ts";

/** One run: `{ run, ledger, ledgerError?, approvals }`. */
export const Route = createFileRoute("/api/runs/$id/")({
  server: {
    handlers: {
      GET: async ({ params, context }) => json(await runDetail(context.app, params.id)),
    },
  },
});
