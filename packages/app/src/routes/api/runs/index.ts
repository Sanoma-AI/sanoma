import { createFileRoute } from "@tanstack/react-router";
import { RunsQuery, StartRunRequest } from "../../../api.ts";
import { json, parse, readJson, requireActor, startRun } from "../../../server/core.ts";

export const Route = createFileRoute("/api/runs/")({
  server: {
    handlers: {
      /** Recent runs, newest first, or those with `?status=`. */
      GET: async ({ request, context }) => {
        const query = parse(RunsQuery, Object.fromEntries(new URL(request.url).searchParams), "The query");
        return json(await context.app.client.runs(query));
      },
      /** Starts a run as the actor: 201 `{ runId }`. */
      POST: async ({ request, context }) => {
        const actor = requireActor(context);
        const body = parse(StartRunRequest, await readJson(request), 'Send {"workflow": name, "input": {...}}');
        return json(await startRun(context.app, actor, body), 201);
      },
    },
  },
});
