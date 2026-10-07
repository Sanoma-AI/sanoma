import { createFileRoute } from "@tanstack/react-router";
import { StartRunRequest } from "../../../api.ts";
import { getApp } from "../../../server/app.ts";
import { json, listRuns, parse, readJson, requireActor, respond, runsLimit, startRun } from "../../../server/core.ts";

export const Route = createFileRoute("/api/runs/")({
  server: {
    handlers: {
      /** Recent runs, newest first. */
      GET: ({ request }) => respond("GET /api/runs", async () => json(await listRuns(runsLimit(new URL(request.url))))),
      /** Starts a run as the actor: 201 `{ runId }`. */
      POST: ({ request }) =>
        respond("POST /api/runs", async () => {
          const actor = await requireActor(getApp(), request);
          const body = parse(StartRunRequest, await readJson(request), 'Send {"workflow": name, "input": {...}}');
          return json(await startRun(actor, body), 201);
        }),
    },
  },
});
