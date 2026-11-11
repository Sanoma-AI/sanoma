import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { postMcp } from "../server/mcp.ts";

/**
 * The company's agent surface, an MCP server over Streamable HTTP (server/mcp.ts), as the person
 * the login names. Its own CSRF check, as start.ts's covers only server functions: a browser's
 * request from another site (`Sec-Fetch-Site`, else `Origin`, else `Referer`) is refused, and one
 * that says none of them, as an MCP client's, is let through (`allowRequestsWithoutOriginCheck`):
 * a browser says at least one on a cross-site POST. `postMcp` refuses another site's `Origin` itself too.
 */
export const Route = createFileRoute("/mcp")({
  server: {
    middleware: [createCsrfMiddleware({ allowRequestsWithoutOriginCheck: true })],
    handlers: {
      POST: ({ request, context }) => postMcp(request, context),
      GET: ({ request, context }) => postMcp(request, context),
      DELETE: ({ request, context }) => postMcp(request, context),
    },
  },
});
