import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

// The server bundle's entry (dist/server/server.js). startApp calls its `fetch` with
// `{ context: { app } }`; Start hands that context to middleware, server routes, server
// functions and the router (see the Register augmentation in context.ts).
export default createServerEntry({
  fetch(request, opts) {
    return handler.fetch(request, opts);
  },
});
