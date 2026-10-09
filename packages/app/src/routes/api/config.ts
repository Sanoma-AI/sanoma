import { createFileRoute } from "@tanstack/react-router";
import { json, withoutSources } from "../../server/core.ts";

/**
 * `describeConfig(config)`: the workflows with their input schemas and outlines, their
 * operations, the policy and the version. Without the workflows' sources (`withoutSources`).
 */
export const Route = createFileRoute("/api/config")({
  server: {
    handlers: {
      GET: ({ context }) => json(withoutSources(context.app.description)),
    },
  },
});
