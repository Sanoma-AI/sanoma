import { createFileRoute } from "@tanstack/react-router";
import { json, scenarios } from "../../server/core.ts";

/**
 * Every scenario in the config's feature files (`{ name, workflow, file, text, steps }`), and an
 * error for each file that could not be read. Read afresh on each request.
 */
export const Route = createFileRoute("/api/scenarios")({
  server: {
    handlers: {
      GET: ({ context }) => json(scenarios(context.app)),
    },
  },
});
