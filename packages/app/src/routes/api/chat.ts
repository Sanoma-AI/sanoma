import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { postChat } from "../../server/chat.ts";

/**
 * The operator agent's chat: a turn's reply as a UI message stream, which the worker's run of the
 * turn writes (server/chat.ts). A server route, so its own CSRF check: start.ts's covers only
 * server functions.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    middleware: [createCsrfMiddleware()],
    handlers: { POST: ({ request, context }) => postChat(request, context) },
  },
});
