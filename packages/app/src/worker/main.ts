// The app bundle's main module (`buildAppBundle`): the app's fetch handler for the Worker
// (`AppBundleModule`). It imports the app on the first request, not at the Worker's start, so the
// isolate starts with this module alone; the app's route chunks load as their pages are asked for.
import type { AppBundleContext, AppBundleEnv, AppBundleModule, AppHost } from "../app-bundle.ts";

let app: Promise<typeof import("./app.ts")> | undefined;

export default {
  async fetch(request: Request, env: AppBundleEnv, ctx: AppBundleContext, host?: AppHost) {
    return (await (app ??= import("./app.ts"))).serve(request, env, ctx, host);
  },
} satisfies AppBundleModule;
