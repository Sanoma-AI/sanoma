// The company's Worker script, as `cloudflare.host` uploads it: the app bundle's fetch (under
// `app/`, imported on the first request) and the Durable Object class `SanomaInstance`, which runs
// the company's worker in its container. The logic is `instance.js`'s, which has no imports, so the
// connector's fake runs it too.
import { DurableObject } from "cloudflare:workers";
import { Instance, serve } from "./instance.js";

export class SanomaInstance extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.instance = new Instance(ctx, env);
  }

  fetch(request) {
    return this.instance.fetch(request);
  }

  alarm(info) {
    return this.instance.alarm(info);
  }

  /** Over RPC, from the app on the Worker: a run was queued, or a wake came. */
  startNow() {
    return this.instance.startNow();
  }
}

export default {
  // The import is this module's, so its specifier is relative to the upload; the fake gives its own.
  fetch: (request, env, ctx) => serve(request, env, ctx, () => import("./app/index.js")),
};
