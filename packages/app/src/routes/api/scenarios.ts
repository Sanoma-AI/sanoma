import { createFileRoute } from "@tanstack/react-router";
import { json, scenarios } from "../../server/core.ts";

/**
 * Every scenario in the config's feature files (`{ name, workflow, file, text, steps }`), and an
 * error for each file that could not be read. Read again whenever a feature file has changed.
 */
export const Route = createFileRoute("/api/scenarios")({
  server: {
    handlers: {
      GET: ({ context }) => json(scenarios(context.app)),
    },
  },
});
