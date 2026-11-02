// The company's Worker when it serves public sites: the main module `cloudflare.container`
// uploads in place of `index.js` once the container built the sites bundle (`sites/index.js`,
// `buildWorker` in `@sanoma-ai/app/build`). A request the bundle serves (a page of a public site
// without a login, on its domain) is answered here, on the Worker, and never waits for the
// container; everything else goes to the one object, as `index.js` sends it. A run a page starts
// has the object start the container (`startNow`), which runs it.
import { NAMESPACE, worker } from "./instance.js";
import sites from "./sites/index.js";

export { SanomaInstance } from "./index.js";

export default {
  fetch(request, env, ctx) {
    if (!sites.serves(request, env)) return worker.fetch(request, env);
    return sites.fetch(request, env, ctx, { startNow: () => env[NAMESPACE].getByName("instance").startNow() });
  },
};
