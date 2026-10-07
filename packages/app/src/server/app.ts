import { getGlobalStartContext } from "@tanstack/react-start";
import type { AppContext } from "../context.ts";

declare module "@tanstack/react-router" {
  interface Register {
    server: { requestContext: { app: AppContext } };
  }
}

/**
 * The app's context, from the request Start is handling. Server routes, server functions and
 * loaders running on the server all see it: `startApp` passes it to every `handler.fetch`.
 */
export function getApp(): AppContext {
  const app = (getGlobalStartContext() as { app?: AppContext } | undefined)?.app;
  if (!app) {
    throw new Error("No Sanoma app context on this request: serve the app with startApp(config), not on its own");
  }
  return app;
}
