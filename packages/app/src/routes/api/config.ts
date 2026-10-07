import { createFileRoute } from "@tanstack/react-router";
import { getApp } from "../../server/app.ts";
import { json, respond } from "../../server/core.ts";

/** `describeConfig(config)`: the workflows, their operations and input schemas, the policy and the version. */
export const Route = createFileRoute("/api/config")({
  server: {
    handlers: {
      GET: () => respond("GET /api/config", async () => json(getApp().description)),
    },
  },
});
