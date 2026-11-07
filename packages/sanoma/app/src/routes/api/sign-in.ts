import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { postSignInCode } from "../../server/chat.ts";

/**
 * The code a person pastes on their own agent's sign-in card, for the vendor's sign-in waiting in
 * their chat's turn (server/chat.ts). A server route beside `/api/chat`, with its own CSRF check.
 */
export const Route = createFileRoute("/api/sign-in")({
  server: {
    middleware: [createCsrfMiddleware()],
    handlers: { POST: ({ request, context }) => postSignInCode(request, context) },
  },
});
