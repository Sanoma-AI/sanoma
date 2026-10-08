// The server bundle's entry (dist/server/server.js): Start's own. startApp calls its `fetch`
// with `{ context: { app } }`, which Start hands to middleware, server routes, server functions
// and the router (see the Register augmentation in start.ts).
export { default } from "@tanstack/react-start/server-entry";
