import { createFileRoute } from "@tanstack/react-router";
import { json } from "../../server/core.ts";

/** `describeConfig(config)`: the workflows with their input schemas and outlines, their operations, the policy and the version. */
export const Route = createFileRoute("/api/config")({
  server: {
    handlers: {
      GET: ({ context }) => json(context.app.description),
    },
  },
});
