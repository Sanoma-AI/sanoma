import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { notHere } from "../../server/core.ts";
import { local } from "../../server/local/index.ts";

/**
 * The operator agent's chat: a turn as a UI message stream (server/agent/turn.ts). A server route,
 * so its own CSRF check: start.ts's covers only server functions.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    middleware: [createCsrfMiddleware()],
    handlers: {
      POST: ({ request, context }) =>
        local
          ? local.postChat(request, context)
          : Response.json({ error: notHere("The agent's chat") }, { status: 501 }),
    },
  },
});
