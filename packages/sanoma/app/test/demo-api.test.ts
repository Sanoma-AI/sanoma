// A demo's `api` in the page (`demo/api.ts`): which mounted demo's runtime answers it.
import type { PageRuntime } from "sanoma/workflows/page";
import { describe, expect, it } from "vitest";
import type { UntypedApi } from "../src/api-client.ts";
import { api, serve } from "../src/demo/api.ts";

/** A runtime, seeded, that answers every request with its own name. */
const runtime = (name: string) =>
  Promise.resolve<PageRuntime>({ transport: async () => name, reset: async () => {}, stop: () => {} });
const read = () => (api as UntypedApi).data.invoices.list({});
/** Serves `seeding` as `mount` does, returning once it has seeded or failed, as `mount` renders. */
const mounted = async (seeding: Promise<PageRuntime>) => {
  const release = serve(seeding);
  await seeding.catch(() => {});
  return release;
};

describe("a demo's api", () => {
  it("is the runtime of the demo mounted last of those still mounted, whichever unmounts first", async () => {
    const releaseA = await mounted(runtime("A"));
    const releaseB = await mounted(runtime("B"));
    try {
      expect(await read()).toBe("B");
      releaseB();
      expect(await read()).toBe("A");
      const releaseC = await mounted(runtime("C"));
      releaseA();
      expect(await read()).toBe("C");
      releaseC();
      await expect(read()).rejects.toMatchObject({ status: 503 });
    } finally {
      releaseA();
      releaseB();
    }
  });

  it("goes by the order mounts are called, once each has seeded; a world that never seeds answers nothing", async () => {
    let seedSlow!: (runtime: PageRuntime) => void;
    const slow = new Promise<PageRuntime>((resolve) => (seedSlow = resolve));
    const releaseSlow = serve(slow);
    const releaseFast = await mounted(runtime("fast"));
    const releaseFailed = await mounted(Promise.reject(new Error("no world")));
    try {
      expect(await read()).toBe("fast");
      seedSlow(await runtime("slow"));
      await slow;
      expect(await read()).toBe("fast");
      releaseFast();
      expect(await read()).toBe("slow");
    } finally {
      for (const release of [releaseSlow, releaseFast, releaseFailed]) release();
    }
  });
});
