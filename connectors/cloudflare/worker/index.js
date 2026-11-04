// The company's Worker on Cloudflare, uploaded by `cloudflare.container` beside `instance.js`:
// every request goes to its one Durable Object, which runs the company's container and holds its
// wake. The logic is `instance.js`'s, which has no imports, so the connector's fake runs it too.
import { DurableObject } from "cloudflare:workers";
import { Instance, worker } from "./instance.js";

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

  /** Over RPC, from the sites router (`sites.js`): a page on the Worker queued a run. */
  startNow() {
    return this.instance.startNow();
  }
}

export default worker;
