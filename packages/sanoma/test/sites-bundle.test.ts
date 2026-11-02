import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SanomaConfig } from "@sanoma-ai/workflows";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sitesBundleRoute } from "../src/sites-bundle.ts";

// The container's bundle route over a stubbed `@sanoma-ai/app/build`: `buildWorker` itself runs
// in `packages/app/test/worker-build.test.ts`.

const buildWorker = vi.fn<(repo: string, options: object) => Promise<unknown>>();
vi.mock("../src/sites.ts", () => ({ siteBuild: async () => ({ buildWorker }) }));
vi.mock("@sanoma-ai/workflows", async (actual) => ({
  ...(await actual<object>()),
  readRootSnapshot: () => ({ appName: "acme" }),
}));

const TOKEN = "swi_the-company-token";
const root = mkdtempSync(join(tmpdir(), "sanoma-sites-bundle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config: SanomaConfig = { workflows: [], connectors: [], root, file: join(root, "sanoma.config.ts") };
const log = vi.fn<(line: string) => void>();
let route: ReturnType<typeof sitesBundleRoute>;
beforeEach(() => {
  buildWorker.mockReset();
  route = sitesBundleRoute(config, { root, domains: { www: "www.acme.example" }, token: TOKEN, log });
});
const ask = (token = TOKEN) =>
  route.handle(
    new Request("http://container/__sanoma/sites-bundle", { headers: { authorization: `Bearer ${token}` } }),
  );
/** Asks until the build settled: what it answers then. */
async function settled() {
  for (;;) {
    const res = await ask();
    if (res.status !== 202) return res;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("sitesBundleRoute", () => {
  it("builds the bundle on the first ask, answers 202 while it builds, then the bundle, each site on its domain", async () => {
    const bundle = { sites: ["www"], mainModule: "index.js", modules: [], assets: [] };
    buildWorker.mockResolvedValue(bundle);
    expect(route).toMatchObject({ method: "GET", path: "/__sanoma/sites-bundle" });
    expect((await ask()).status).toBe(202);
    const res = await settled();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(bundle);
    expect(buildWorker).toHaveBeenCalledOnce();
    const [repo, options] = buildWorker.mock.calls[0]!;
    expect(repo).toBe(root);
    expect(options).toMatchObject({ configFile: config.file, snapshot: { appName: "acme" } });
    // Built once: asked again, the same bundle.
    expect((await ask()).status).toBe(200);
    expect(buildWorker).toHaveBeenCalledOnce();
  });

  it("answers 404 when no site is the Worker's", async () => {
    buildWorker.mockResolvedValue(undefined);
    expect((await settled()).status).toBe(404);
  });

  it("answers a failed build 500 with why, once, and builds again on the next ask", async () => {
    buildWorker.mockRejectedValueOnce(new Error("sites/www/routes/index.tsx: Unexpected token"));
    const res = await settled();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sites/www/routes/index.tsx: Unexpected token" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Unexpected token"));
    buildWorker.mockResolvedValue(undefined);
    expect((await ask()).status).toBe(202);
    expect((await settled()).status).toBe(404);
  });

  it("refuses another token, building nothing", async () => {
    expect((await ask("swi_another")).status).toBe(401);
    expect((await route.handle(new Request("http://container/__sanoma/sites-bundle"))).status).toBe(401);
    expect(buildWorker).not.toHaveBeenCalled();
  });
});
