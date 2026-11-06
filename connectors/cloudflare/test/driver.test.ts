import { createHash } from "node:crypto";
import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "../src/connector.ts";
import { cloudflareDriver } from "../src/driver.ts";
import { API, cfResult, replayOptions, TEST_ACCOUNT } from "./replay.ts";

// Replays test/fixtures, written from Cloudflare's API reference (README, "Testing the driver").
// Live, `test/live.ts` and the features run against an account instead: these tests check the
// requests the driver makes and how it reads made-up replies.

const { server, play, fixture, sent } = replay(replayOptions);

/** The runtime image's repository in the fixtures' account's registry. */
const RUNS = `registry.cloudflare.com/${TEST_ACCOUNT}/sanoma-ai-runtime`;
/** Its 0.7.0 and 0.8.0, pinned by digest as the object starts them: the fixtures' made-up digests. */
const PINNED = `${RUNS}@sha256:${"7".repeat(64)}`;
const PINNED_NEXT = `${RUNS}@sha256:${"8".repeat(64)}`;
const PREPARATIONS = "/containers/image-preparations";
/** The zone `acme.example` in the `domains` fixture. */
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";

const TOKEN = "swi_the-company-token";
const URL_OF = "https://sanoma-company.example.workers.dev";
const callWith = (values: Record<string, string> = {}): CallContext => ({
  idempotencyKey: "run-1:1",
  runId: "run-1",
  opId: "cloudflare.container.create",
  attempt: 1,
  secrets: memorySecrets(values),
});
// One driver per test: it keeps the account's subdomain once read.
let driver: ReturnType<typeof cloudflareDriver>;
beforeEach(() => {
  driver = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 1_000, pollMs: 1 });
});
/** The host's database, as its secret holds it: Hyperdrive's origin is made of it. */
const DATABASE_URL = "postgresql://sanoma:p%40ss@db.acme.example:5432/company";
const op = (name: string, input: object, call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: DATABASE_URL })) =>
  driver.ops[name]!(input, call);

const desired = {
  name: "company",
  image: PINNED,
  source: "https://github.com/acme/company.git",
  ref: "main",
  revision: "abc123",
  port: 3000,
  secrets: {
    SANOMA_WAKEUP_TOKEN: { $secret: "SANOMA_WAKEUP_TOKEN" },
    SANOMA_DATABASE_URL: { $secret: "DB_URL" },
  },
};
const state = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "company",
  image: PINNED,
  source: "https://github.com/acme/company.git",
  ref: "main",
  revision: "abc123",
  port: 3000,
  url: URL_OF,
  worker_url: URL_OF,
  healthy: true,
};

/** `answer` to a restart's health (`?start=1`); the fixture's for an upload's wait to be live. */
const restart = (request: Request, answer: Response) =>
  new URL(request.url).searchParams.has("start") ? answer : undefined;

/** The exchanges of `name` that match `keep`. */
const only = (name: string, keep: (e: Exchange, i: number) => boolean) => fixture(name).filter(keep);
const apiPath = (path: string) => `${API}${path}`;
const BUNDLE = "/__sanoma/app-bundle?revision=abc123";
/** The create of the `create` fixture up to its first ask for the app bundle, then `asks`. */
const createWith = (...asks: Exchange[]) => [
  ...fixture("create").slice(
    0,
    fixture("create").findIndex((e) => e.path === BUNDLE),
  ),
  ...asks,
];
/** The version the create's Worker without an app answers with: its second upload's, after the application. */
const CREATED = { "x-sanoma-deployment": "00000002-0000-4000-a000-000000000000" };
/** The version of a Worker at def456 serving the app at abc123, uploaded by a stale deployment's deploy. */
const SERVING = "00000007-0000-4000-a000-000000000000";
/** `e` answered by the version `SERVING`, or, an upload's, answering with it. */
const servingAbc = (e: Exchange) =>
  e.method === "PUT"
    ? {
        ...e,
        body: { ...(e.body as object), result: { ...(e.body as { result: object }).result, deployment_id: SERVING } },
      }
    : { ...e, headers: { ...e.headers, "x-sanoma-deployment": SERVING } };
/** The deploy's reads of what is deployed, between its writes. */
const reads = (r: string) => r === "GET /workers/subdomain" || r.endsWith("/settings") || r.includes(PREPARATIONS);
/** The header the worker's bundle route marks its answers with, as the create's object passes them on. */
const ROUTE = { "x-sanoma-app-bundle": "1", ...CREATED };
const reply = (path: string, status: number, body: unknown, method = "GET"): Exchange => ({
  method,
  path,
  status,
  body,
});
const wake = (status: number, body: unknown, method = "GET") => reply("/__sanoma/wake", status, body, method);
const cfError = (code: number, message: string) => ({
  success: false,
  errors: [{ code, message }],
  messages: [],
  result: null,
});

/** An asset's hash in an assets upload session's manifest, as the direct upload guide's example makes it. */
const hashOf = (base64: string, extension: string) =>
  createHash("sha256")
    .update(base64 + extension)
    .digest("hex")
    .slice(0, 32);

/** The upload's form, as Cloudflare reads it. */
async function formOf(request: (typeof sent)[number]) {
  return new Response(request.body as string, {
    headers: { "content-type": request.headers.get("content-type")! },
  }).formData();
}
/** An upload form's `metadata` part, the JSON. */
async function metadataOf(form: FormData) {
  return JSON.parse(await (form.get("metadata") as File).text());
}
/** The metadata of the Worker's last upload among the requests sent. */
async function uploaded() {
  return metadataOf(
    await formOf(sent.findLast((r) => r.method === "PUT" && r.path === `${API}/workers/scripts/sanoma-company`)!),
  );
}

/** `e`, a Worker's settings, with one more plain-text binding. */
const withText = (e: Exchange, name: string, text: string): Exchange => {
  const body = structuredClone(e.body) as { result: { bindings: object[] } };
  body.result.bindings.push({ type: "plain_text", name, text });
  return { ...e, body };
};
/** The Worker's attached custom domains, `hostnames`. */
const attachedDomains = (...hostnames: string[]) =>
  reply(
    apiPath("/workers/domains?service=sanoma-company"),
    200,
    cfResult(hostnames.map((hostname, i) => ({ id: `d${i + 1}`, hostname, service: "sanoma-company", zone_id: ZONE }))),
  );
/** An attach Cloudflare refuses. */
const attachRefused = reply(
  apiPath("/workers/domains"),
  409,
  cfError(100117, "Hostname already has a DNS record"),
  "PUT",
);
/** Cloudflare's reply to the detach of the custom domain `id`. */
const detached = (id: string) =>
  reply(apiPath(`/workers/domains/${id}`), 200, { success: true, errors: [], messages: [] }, "DELETE");
/** Cloudflare's reply to the attach of `new.acme.example`. */
const attachedNew = reply(
  apiPath("/workers/domains"),
  200,
  cfResult({ id: "d2", hostname: "new.acme.example", service: "sanoma-company", zone_id: ZONE }),
  "PUT",
);
/** The zone lookup of `acme.example`. */
const zoneLookup = () => fixture("hostname").find((e) => e.path.startsWith("/client/v4/zones?"))!;
/** The registry's temporary credentials, as the SDK's `containers.registries.credentials.generate` answers. */
const registryCredentials = reply(
  apiPath("/containers/registries/registry.cloudflare.com/credentials"),
  200,
  cfResult({
    account_id: TEST_ACCOUNT,
    registry_host: "registry.cloudflare.com",
    username: "v1",
    password: "temporary",
  }),
  "POST",
);

/**
 * A rename's requests up to its upload, from the Worker serving `old.acme.example`: its plan, its
 * reads, the image's preparation, the database's config, the bundle, then the detach of the old name.
 */
const renameUntilUpload = (updated: Exchange[]) => {
  const attached = attachedDomains("old.acme.example");
  return [
    withText(updated[0]!, "SANOMA_HOSTNAME", "old.acme.example"),
    updated[1]!,
    updated[2]!,
    attached,
    withText(updated[3]!, "SANOMA_HOSTNAME", "old.acme.example"),
    attached,
    zoneLookup(),
    ...updated.slice(4, 12),
    detached("d1"),
  ];
};
const renamed = { ...desired, revision: "def456", hostname: "new.acme.example" };
const renamedState = {
  ...state,
  revision: "def456",
  hostname: "new.acme.example",
  url: "https://new.acme.example",
};
const update = (input: object) =>
  op("container.update", { id: "company", ...input, expect: { action: "update", replace: [] } });
/** The requests' methods and paths from `from` on, without the API's prefix. */
const requests = (from = 0) => sent.slice(from).map((r) => `${r.method} ${r.path.replace(API, "")}`);

describe.skipIf(live)("cloudflareDriver", () => {
  describe("cloudflare.container", () => {
    it("prepares the image, uploads the Worker with its bindings, image and migration, turns its URL on, makes its application and waits for it", async () => {
      play("create");
      const made = await op("container.create", { desired });
      expect(made).toEqual({ id: "company", state });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`)).toEqual([
        "GET /workers/subdomain",
        "GET /workers/scripts/sanoma-company/settings",
        // Pending, then ready: polled before anything changes.
        `POST ${PREPARATIONS}`,
        `POST ${PREPARATIONS}`,
        // The database's config, made before the Worker that binds it.
        "GET /hyperdrive/configs?per_page=50",
        "POST /hyperdrive/configs",
        // Without an app until its first bundle.
        "PUT /workers/scripts/sanoma-company",
        "POST /workers/scripts/sanoma-company/subdomain",
        "GET /containers/applications?name=sanoma-company",
        "GET /workers/scripts/sanoma-company/settings",
        "POST /containers/applications",
        // Again, once the application exists: the object's namespace learns it from this deployment.
        "PUT /workers/scripts/sanoma-company",
        // Live: the object answers as the version uploaded.
        "GET /__sanoma/health",
        // 1. The bundle: the object starts the container, then the worker builds it.
        `GET ${BUNDLE}`,
        `GET ${BUNDLE}`,
        `GET ${BUNDLE}`,
        "POST /workers/scripts/sanoma-company/assets-upload-session",
        "POST /workers/assets/upload?base64=true",
        // 2. One upload, live.
        "PUT /workers/scripts/sanoma-company",
        "GET /__sanoma/health",
        // 3. The restart.
        "GET /__sanoma/health?start=1",
      ]);
      // Compared, not printed: a failure must not show a live token.
      expect(sent.slice(0, 12).every((r) => r.headers.get("authorization") === "Bearer test-token")).toBe(true);
      expect(sent.slice(13, 16).every((r) => r.headers.get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
      expect(sent.at(-1)!.headers.get("authorization") === `Bearer ${TOKEN}`).toBe(true);
      const again = await metadataOf(await formOf(sent[11]!));
      expect(again.migrations).toBeUndefined();
      expect(sent[2]!.body).toEqual({ image: PINNED });
      // Query caching off, over the declared URL, its password decoded.
      expect(sent[5]!.body).toEqual({
        name: "sanoma-company",
        origin: {
          scheme: "postgresql",
          host: "db.acme.example",
          port: 5432,
          database: "company",
          user: "sanoma",
          password: "p@ss",
        },
        caching: { disabled: true },
      });

      const upload = sent[6]!;
      expect(upload.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const form = await formOf(upload);
      // One `metadata` part, the JSON, as Cloudflare reads it; the modules as parts named after them.
      const metadata = await metadataOf(form);
      expect(metadata.main_module).toBe("index.js");
      expect(metadata.compatibility_date).toBe("2026-10-01");
      expect(metadata.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["SanomaInstance"] });
      // Its object runs a container (without this, it has no `ctx.container`), at the pinned image it names.
      expect(metadata.containers).toEqual([
        { name: "sanoma-company", class_name: "SanomaInstance", images: { runtime: PINNED } },
      ]);
      expect(metadata.bindings.map((b: { name: string }) => b.name)).toEqual([
        "SANOMA_INSTANCE",
        "CF_VERSION_METADATA",
        "SANOMA_SOURCE",
        "SANOMA_REF",
        "SANOMA_REVISION",
        "SANOMA_IMAGE",
        "PORT",
        "SANOMA_HOST_URL",
        "SANOMA_WAKEUP_TOKEN",
        "SANOMA_DATABASE_URL",
      ]);
      expect(metadata.bindings.map((b: { text?: string }) => b.text)).toContain(URL_OF);
      // The secrets go as secret bindings, resolved at the call.
      expect(metadata.bindings.slice(-2)).toMatchObject([
        { type: "secret_text", text: TOKEN },
        { type: "secret_text", text: DATABASE_URL },
      ]);
      const files = ["index.js", "instance.js", "app/index.js"].map((name) => form.get(name) as File);
      expect(files.map((f) => [f.name, f.type])).toEqual([
        ["index.js", "application/javascript+module"],
        ["instance.js", "application/javascript+module"],
        ["app/index.js", "application/javascript+module"],
      ]);
      expect(await files[0]!.text()).toContain('from "cloudflare:workers"');
      // No app yet: the placeholder.
      expect(await files[2]!.text()).toContain("being set up");

      expect(sent[7]!.body).toEqual({ enabled: true });
      // The policy's whole body: the image and the instance type are the object's.
      expect(sent[10]!.body).toEqual({
        name: "sanoma-company",
        scheduling_policy: "durable_object",
        // The namespace the upload made, as the Worker's settings name it.
        durable_objects: { namespace_id: "0123456789abcdef0123456789abcde0" },
        observability: { logs: { enabled: true } },
      });
    });

    it("uploads a new image without the migration, and polls until the Worker answers at the new revision", async () => {
      play("update-to-a-new-image");
      const next = {
        ...desired,
        image: PINNED_NEXT,
        revision: "def456",
      };
      const done = await op("container.update", {
        id: "company",
        desired: next,
        expect: { action: "update", replace: [] },
      });
      expect(done).toEqual({ id: "company", state: { ...state, image: next.image, revision: "def456" } });
      const metadata = await uploaded();
      expect(metadata.migrations).toBeUndefined();
      // A new image is a new upload naming it: the application is left as it is.
      expect(metadata.containers[0].images).toEqual({ runtime: PINNED_NEXT });
      expect(sent.find((r) => r.path.endsWith(PREPARATIONS))!.body).toEqual({ image: PINNED_NEXT });
      expect(sent.some((r) => r.method === "POST" && r.path.includes("/containers/applications"))).toBe(false);
      // R's container, started for the bundle, runs at R already.
      expect(sent.filter((r) => r.path === "/__sanoma/health?start=1")).toHaveLength(1);
    });

    it("copies a ghcr.io image into the account's registry first, with credentials Cloudflare makes, and runs the copy pinned", async () => {
      // The distribution API's replies (OCI distribution spec) and the credentials' (the SDK's
      // `containers.registries.credentials.generate`), written by hand. The copy is in the account
      // already, so nothing more is pushed: registry.test.ts copies blobs against registries here.
      const OCI = "application/vnd.oci.image.manifest.v1+json";
      const manifest = JSON.stringify({ schemaVersion: 2, mediaType: OCI, config: {}, layers: [] });
      const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
      const copy = `/v2/${TEST_ACCOUNT}/sanoma-ai-runtime/manifests/0.7.0`;
      const [subdomain, settings, ...rest] = fixture("create");
      play("copy-an-image", [
        subdomain!,
        settings!,
        registryCredentials,
        {
          method: "GET",
          path: "/v2/",
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
          body: null,
        },
        reply("/token?service=ghcr.io&scope=repository:sanoma-ai/runtime:pull", 200, { token: "anonymous" }),
        {
          method: "GET",
          path: "/v2/sanoma-ai/runtime/manifests/0.7.0",
          status: 200,
          headers: { "content-type": OCI },
          body: manifest,
        },
        reply("/v2/", 200, null),
        { method: "HEAD", path: copy, status: 200, headers: { "docker-content-digest": digest }, body: null },
        ...rest,
      ]);
      const made = await op("container.create", { desired: { ...desired, image: "ghcr.io/sanoma-ai/runtime:0.7.0" } });
      expect(made).toEqual({ id: "company", state: { ...state, image: "ghcr.io/sanoma-ai/runtime:0.7.0" } });
      const credentials = sent.find((r) => r.path.endsWith("/credentials"))!;
      expect(credentials.body).toEqual({ permissions: ["push", "pull"], expiration_minutes: 60 });
      expect(
        sent.find((r) => r.path.endsWith("/manifests/0.7.0") && r.method === "GET")!.headers.get("authorization"),
      ).toBe("Bearer anonymous");
      const head = sent.find((r) => r.method === "HEAD")!;
      expect(head.headers.get("authorization")).toBe(`Basic ${Buffer.from("v1:temporary").toString("base64")}`);
      // The copy, pinned by the manifest's digest, is what is prepared and what the object starts.
      expect(sent.find((r) => r.path.endsWith(PREPARATIONS))!.body).toEqual({ image: `${RUNS}@${digest}` });
      expect((await uploaded()).containers[0].images).toEqual({ runtime: `${RUNS}@${digest}` });
    });

    it("pins an image in the account's registry by a tag to its manifest's digest, copying nothing", async () => {
      const [subdomain, settings, ...rest] = fixture("create");
      const manifest = `/v2/${TEST_ACCOUNT}/sanoma-ai-runtime/manifests/0.7.0`;
      const digest = PINNED.split("@")[1]!;
      play("pin-a-tag", [
        subdomain!,
        settings!,
        registryCredentials,
        reply("/v2/", 200, null),
        { method: "HEAD", path: manifest, status: 200, headers: { "docker-content-digest": digest }, body: null },
        ...rest,
      ]);
      const made = await op("container.create", { desired: { ...desired, image: `${RUNS}:0.7.0` } });
      expect(made).toEqual({ id: "company", state: { ...state, image: `${RUNS}:0.7.0` } });
      expect(sent.filter((r) => r.path.startsWith("/v2/")).map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /v2/",
        `HEAD ${manifest}`,
      ]);
      expect((await uploaded()).containers[0].images).toEqual({ runtime: PINNED });
    });

    it("fails, without retrying and before uploading, when Cloudflare cannot prepare the image", async () => {
      const [subdomain, settings] = fixture("create");
      play("prepare-failed", [
        subdomain!,
        settings!,
        reply(
          apiPath(PREPARATIONS),
          200,
          cfResult({ image: PINNED, status: "error", reason: "the image is not for linux/amd64" }),
          "POST",
        ),
      ]);
      await expect(op("container.create", { desired })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: `cloudflare: preparing ${PINNED}: the image is not for linux/amd64`,
      });
      expect(sent.some((r) => r.method === "PUT")).toBe(false);
    });

    it("fails as retryable when the image is still not prepared after fifteen minutes", async () => {
      const [subdomain, settings] = fixture("create");
      play("prepare-slow", [subdomain!, settings!]);
      server.use(
        http.post(`*${PREPARATIONS}`, () =>
          HttpResponse.json(cfResult({ image: PINNED, status: "pending", reason: "pulling" }), { status: 202 }),
        ),
      );
      // A minute passes at each look at the clock.
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));
      try {
        await expect(op("container.create", { desired })).rejects.toMatchObject({
          name: "DriverError",
          retryable: true,
          message: `cloudflare: preparing ${PINNED}: not ready in 15 min (pulling)`,
        });
      } finally {
        clock.mockRestore();
      }
      expect(sent.some((r) => r.method === "PUT")).toBe(false);
    });

    it("keeps asking whether the image is prepared through one failed look", async () => {
      play(
        "prepare-flaky",
        fixture("create").filter((e) => !e.path.endsWith(PREPARATIONS)),
      );
      let looks = 0;
      server.use(
        http.post(`*${PREPARATIONS}`, () =>
          ++looks === 1
            ? HttpResponse.json(cfError(10000, "internal error"), { status: 503 })
            : HttpResponse.json(cfResult({ image: PINNED, status: "ready" }), { status: 200 }),
        ),
      );
      expect(await op("container.create", { desired })).toEqual({ id: "company", state });
      expect(looks).toBe(2);
    });

    it("plans nothing for a ghcr.io image the Worker names, whose copy the application runs", async () => {
      // The Worker's `SANOMA_IMAGE` binding holds the declared image; the application its copy.
      play(
        "plan-the-copy",
        only("update", (_, i) => i < 3).map((exchange) =>
          JSON.parse(
            JSON.stringify(exchange).replaceAll(`"text":"${PINNED}"`, '"text":"ghcr.io/sanoma-ai/runtime:0.7.0"'),
          ),
        ),
      );
      const planned = await op("container.plan", {
        id: "company",
        desired: { ...desired, image: "ghcr.io/sanoma-ai/runtime:0.7.0" },
      });
      expect(planned).toMatchObject({ action: "none" });
    });

    it("refuses an update whose plan changed since it was approved", async () => {
      play(
        "plan-changed",
        only("update", (_, i) => i < 3),
      );
      await expect(
        op("container.update", {
          id: "company",
          desired: { ...desired, port: 4000 },
          expect: { action: "replace", replace: ["name"] },
        }),
      ).rejects.toMatchObject({ name: "DriverError", retryable: false, vendorCode: "plan_changed" });
    });

    it("refuses an update that is a replace, without uploading", async () => {
      play(
        "update-is-a-replace",
        only("update", (_, i) => i < 3),
      );
      await expect(
        op("container.update", { id: "company", desired: { ...desired, name: "elsewhere" } }),
      ).rejects.toMatchObject({
        retryable: false,
        vendorCode: "plan_changed",
        message: expect.stringContaining("replace"),
      });
      expect(sent.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
    });

    it("reads what the Worker runs from its bindings, and no secret's value", async () => {
      play("read-only", [
        ...only("update", (_, i) => i < 3),
        reply("/__sanoma/health", 200, { revision: "abc123", running: false }),
      ]);
      // Stopped is healthy: the read asks without starting it.
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: false, state });
    });

    it("reads a Worker whose container does not answer as unhealthy", async () => {
      play("unhealthy", [
        ...only("update", (_, i) => i < 3),
        reply("/__sanoma/health", 503, { error: "the container did not start" }),
      ]);
      expect(await op("container.read", { id: "company" })).toMatchObject({ gone: false, state: { healthy: false } });
    });

    it("reads no Worker as gone, without asking for anything else", async () => {
      play("gone", [
        reply(
          apiPath("/workers/scripts/sanoma-company/settings"),
          404,
          cfError(10007, "This Worker does not exist on your account."),
        ),
      ]);
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: true });
    });

    it("deletes the application, then the Worker with its object's storage, then its database's config", async () => {
      play(
        "delete-only",
        only("delete", (_, i) => i >= 20 && i < 26),
      );
      expect(await op("container.delete", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`)).toEqual([
        "GET /workers/scripts/sanoma-company/settings",
        "GET /containers/applications?name=sanoma-company",
        "DELETE /containers/applications/00000000-0000-4000-8000-000000000001",
        "DELETE /workers/scripts/sanoma-company?force=true",
        // After the Worker that binds it.
        "GET /hyperdrive/configs?per_page=50",
        "DELETE /hyperdrive/configs/1e2d3c4b5a69788796a5b4c3d2e1f001",
      ]);
    });

    it("leaves a Worker of that name that is not Sanoma's alone: reads it as gone, refuses to overwrite or delete it", async () => {
      const foreign = reply(
        apiPath("/workers/scripts/sanoma-company/settings"),
        200,
        cfResult({ bindings: [{ type: "plain_text", name: "GREETING", text: "hello" }] }),
      );
      play("not-ours", [foreign, ...only("create", (_, i) => i === 0), foreign, foreign]);
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: true });
      await expect(op("container.create", { desired })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        vendorCode: "exists",
      });
      await expect(op("container.delete", { id: "company" })).rejects.toMatchObject({ vendorCode: "exists" });
      expect(sent.some((r) => r.method === "PUT" || r.method === "DELETE")).toBe(false);
    });

    it("attaches the declared domains to the Worker in the zone it looks up, and detaches them at delete", async () => {
      const domains = { www: "www.acme.example" };
      play("domains");
      expect(await op("container.create", { desired: { ...desired, domains } })).toEqual({
        id: "company",
        state: { ...state, domains },
      });
      const attached = sent.find((r) => r.method === "PUT" && r.path === apiPath("/workers/domains"));
      expect(attached!.body).toEqual({ hostname: "www.acme.example", service: "sanoma-company", zone_id: ZONE });
      expect(await op("container.delete", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`).filter((r) => r.includes("domains"))).toEqual([
        "PUT /workers/domains",
        "GET /workers/domains?service=sanoma-company",
        `DELETE /workers/domains/${fixture("domains")
          .find((e) => e.method === "DELETE")!
          .path.split("/")
          .pop()}`,
      ]);
    });

    it("builds the app bundle first, then uploads the Worker once with it, its assets and its database, and restarts the container last", async () => {
      play("create");
      await op("container.create", { desired });
      const bundle = only("create", (e) => e.path === BUNDLE && e.status === 200)[0]!.body as {
        assets: { path: string; content: string; hash: string; size: number }[];
      };
      const [asset] = bundle.assets;
      const session = sent.find((r) => r.path.endsWith("/assets-upload-session"))!;
      expect(session.body).toEqual({ manifest: { [asset!.path]: { hash: asset!.hash, size: asset!.size } } });
      expect(asset!.hash).toBe(hashOf(asset!.content, "js"));
      // One part per asset the bucket names, by its hash: its base64, and the type it is served with,
      // the session's jwt, not the account's token.
      const assets = sent.find((r) => r.path.endsWith("/workers/assets/upload?base64=true"))!;
      expect(assets.headers.get("authorization")).toBe("Bearer eyJhbGciOiJIUzI1NiJ9.session.signature");
      const part = (await formOf(assets)).get(asset!.hash) as File;
      expect([part.type, await part.text()]).toEqual(["text/javascript", asset!.content]);

      const puts = sent.filter((r) => r.method === "PUT" && r.path.endsWith("/scripts/sanoma-company"));
      const [bare, full] = await Promise.all([puts[1]!, puts[2]!].map(async (r) => metadataOf(await formOf(r))));
      const form = await formOf(puts[2]!);
      // The bundle's runtime, its modules under `app/` beside the package's, the assets and the database bound.
      expect(full).toEqual({
        ...bare,
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
          ...bare.bindings,
          { type: "hyperdrive", name: "DATABASE", id: "1e2d3c4b5a69788796a5b4c3d2e1f001" },
          { type: "assets", name: "ASSETS" },
        ],
        assets: {
          jwt: "eyJhbGciOiJIUzI1NiJ9.completion.signature",
          config: { html_handling: "none", not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"] },
        },
        annotations: { "workers/tag": "abc123" },
      });
      expect(bare.compatibility_flags).toEqual([]);
      const modules = ["index.js", "instance.js", "app/index.js", "app/chunk.js", "app/cedar.wasm"];
      expect(modules.map((name) => [name, (form.get(name) as File | null)?.type])).toEqual([
        ["index.js", "application/javascript+module"],
        ["instance.js", "application/javascript+module"],
        ["app/index.js", "application/javascript+module"],
        ["app/chunk.js", "application/javascript+module"],
        ["app/cedar.wasm", "application/wasm"],
      ]);
      expect(await (form.get("app/index.js") as File).text()).toContain('import "./chunk.js"');
    });

    it("updates in the same three steps, setting the database's config again and uploading no asset Cloudflare has", async () => {
      play("update");
      await update({ desired: { ...desired, revision: "def456" } });
      expect(requests().filter((r) => !r.startsWith("GET /workers") && !r.includes(PREPARATIONS))).toEqual([
        "GET /containers/applications?name=sanoma-company",
        "GET /hyperdrive/configs?per_page=50",
        "PUT /hyperdrive/configs/1e2d3c4b5a69788796a5b4c3d2e1f001",
        "POST /workers/scripts/sanoma-company/subdomain",
        "GET /containers/applications?name=sanoma-company",
        // The worker at abc123 builds def456 in a checkout of it.
        "GET /__sanoma/app-bundle?revision=def456",
        "GET /__sanoma/app-bundle?revision=def456",
        "POST /workers/scripts/sanoma-company/assets-upload-session",
        "PUT /workers/scripts/sanoma-company",
        // The upload live, then starting at def456, then there: the object drained abc123 and started it.
        "GET /__sanoma/health",
        "GET /__sanoma/health?start=1",
        "GET /__sanoma/health?start=1",
      ]);
      const upload = await uploaded();
      expect(upload.assets.jwt).toBe("eyJhbGciOiJIUzI1NiJ9.completion.signature");
      // Tagged with the app's revision, which a plan compares.
      expect(upload.annotations).toEqual({ "workers/tag": "def456" });
    });

    it("has R's container build a new image's bundle, the Worker at R serving the app deployed meanwhile, and asks it once that version answers", async () => {
      play("update-to-a-new-image");
      await update({ desired: { ...desired, image: PINNED_NEXT, revision: "def456" } });
      expect(
        requests()
          .filter((r) => !reads(r))
          .slice(5),
      ).toEqual([
        // The deployed app read back, and the Worker at def456 uploaded with it.
        "GET /workers/scripts/sanoma-company/content/v2",
        "PUT /workers/scripts/sanoma-company",
        // The version before still answers, then the upload does.
        "GET /__sanoma/health",
        "GET /__sanoma/health",
        // The version before's 401 is not yet, not stale: def456's container builds it.
        "GET /__sanoma/app-bundle?revision=def456",
        "GET /__sanoma/app-bundle?revision=def456",
        "GET /__sanoma/app-bundle?revision=def456",
        "POST /workers/scripts/sanoma-company/assets-upload-session",
        "PUT /workers/scripts/sanoma-company",
        "GET /__sanoma/health",
        "GET /__sanoma/health?start=1",
      ]);
      const puts = sent.filter((r) => r.method === "PUT" && r.path.endsWith("/scripts/sanoma-company"));
      const first = await formOf(puts[0]!);
      const serving = await metadataOf(first);
      // The app deployed, beside this package's entry and object, its runtime and assets kept, untagged; R's bindings and image.
      expect(await (first.get("app/index.js") as File).text()).toContain('new Response("abc123")');
      expect(await (first.get("instance.js") as File).text()).toContain("DEPLOYMENT_HEADER");
      expect(serving).toMatchObject({
        compatibility_flags: ["nodejs_compat"],
        keep_assets: true,
        assets: { config: { run_worker_first: ["/*", "!/assets/*"] } },
        containers: [{ images: { runtime: PINNED_NEXT } }],
      });
      expect(serving.assets.jwt).toBeUndefined();
      expect(serving.annotations).toBeUndefined();
      expect(serving.bindings).toContainEqual({ type: "plain_text", name: "SANOMA_REVISION", text: "def456" });
      expect(serving.bindings).toContainEqual({
        type: "hyperdrive",
        name: "DATABASE",
        id: "1e2d3c4b5a69788796a5b4c3d2e1f001",
      });
      expect((await metadataOf(await formOf(puts[1]!))).annotations).toEqual({ "workers/tag": "def456" });
    });

    it("refuses when the worker could not build the bundle, saying why", async () => {
      const error = "sites/www/routes/index.tsx: Unexpected token";
      play("bundle-failed", createWith({ ...reply(BUNDLE, 500, { error }), headers: ROUTE }));
      await expect(op("container.create", { desired })).rejects.toMatchObject({
        retryable: false,
        message: `cloudflare: sanoma-company: no app bundle at abc123: ${error}`,
      });
    });

    it.each([
      ["another token", reply("/__sanoma/app-bundle?revision=def456", 401, { error: "the token is not this host's" })],
      ["a runtime without the route", reply("/__sanoma/app-bundle?revision=def456", 404, "<!doctype html>Not found")],
      ["a worker that ends", reply("/__sanoma/app-bundle?revision=def456", 503, { error: "it ended", exit: "exit 1" })],
    ])(
      "recovers a deployment that cannot build the bundle (%s) with the Worker at the revision, still serving the app deployed",
      async (_, stale) => {
        const updated = fixture("update");
        const content = fixture("update-to-a-new-image")[9]!;
        play("bundle-stale", [
          ...updated.slice(0, 9),
          stale,
          content,
          servingAbc(updated[12]!),
          servingAbc(updated[13]!),
          servingAbc(updated[9]!),
          servingAbc(updated[10]!),
          ...updated.slice(11),
        ]);
        await update({ desired: { ...desired, revision: "def456" } });
        const puts = sent.filter((r) => r.method === "PUT" && r.path.endsWith("/scripts/sanoma-company"));
        expect(puts).toHaveLength(2);
        const first = await formOf(puts[0]!);
        // Visitors keep the app deployed: never a page saying it is being set up.
        expect(await (first.get("app/index.js") as File).text()).toContain('new Response("abc123")');
        expect((await metadataOf(first)).bindings).toContainEqual({
          type: "plain_text",
          name: "SANOMA_REVISION",
          text: "def456",
        });
        expect(requests().filter((r) => r.includes("app-bundle"))).toHaveLength(3);
      },
    );

    it("stops asking for the bundle when the object says the container ended", async () => {
      const ended = reply(BUNDLE, 503, {
        error: "the company's container did not start: the container exited",
        exit: "the container exited",
      });
      play("bundle-exit", createWith({ ...ended, headers: CREATED }));
      await expect(op("container.create", { desired })).rejects.toThrow("no app bundle at abc123");
    });

    it.each([
      ["an error of Cloudflare's", reply(BUNDLE, 502, "bad gateway"), "answered 502"],
      [
        "the object's 503 while the container restarts",
        { ...reply(BUNDLE, 503, { error: "did not answer" }), headers: CREATED },
        "did not answer",
      ],
      ["a bundle cut off", { ...reply(BUNDLE, 200, '{"version":"abc123","mainMod'), headers: ROUTE }, "answered 200"],
    ])("asks again on %s, and fails retryably once the bundle's own time is up", async (_, answer, said) => {
      const slow = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 30, pollMs: 5 });
      play("bundle-unanswered", createWith());
      let asked = 0;
      const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      server.use(
        http.get("*/__sanoma/app-bundle", () => {
          asked++;
          return new HttpResponse(body, { status: answer.status, headers: answer.headers });
        }),
      );
      await expect(
        slow.ops["container.create"]!({ desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: DATABASE_URL })),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        message: expect.stringMatching(new RegExp(`still building the app bundle at abc123 after 0 s: .*${said}`)),
      });
      expect(asked).toBeGreaterThan(1);
    });

    it("confirms an update whose upload is made by the restart alone, though the update approved was a deploy", async () => {
      // The Worker runs def456 already: a deploy that died in its restart, or the worker that ran it restarted.
      const [settings, app, subdomain] = only("update", (_, i) => i < 3).map((e) =>
        JSON.parse(JSON.stringify(e).replaceAll('"abc123"', '"def456"')),
      );
      play("restart-alone", [
        settings!,
        app!,
        subdomain!,
        // The plan's read is the restart's: no second read.
        reply("/__sanoma/health?start=1", 202, { revision: "def456", running: true, ready: false }),
        reply("/__sanoma/health?start=1", 200, { revision: "def456", running: true, ready: true }),
      ]);
      expect(await update({ desired: { ...desired, revision: "def456" } })).toEqual({
        id: "company",
        state: { ...state, revision: "def456" },
      });
      expect(sent.some((r) => r.method === "PUT" || r.path.includes("app-bundle"))).toBe(false);
    });

    it("plans an update for a Worker at the revision whose version still serves the app deployed before", async () => {
      // A deploy that ended between its two uploads: R's bindings, the version tagged with R-1's app.
      play(
        "serving-the-app-before",
        only("update", (_, i) => i < 3).map((e) =>
          JSON.parse(JSON.stringify(e).replaceAll('"text":"abc123"', '"text":"def456"')),
        ),
      );
      expect(await op("container.plan", { id: "company", desired: { ...desired, revision: "def456" } })).toMatchObject({
        action: "update",
      });
    });

    it("refuses a host without its database's URL, or with one Hyperdrive cannot take, before any request", async () => {
      const { SANOMA_DATABASE_URL: _url, ...secrets } = desired.secrets;
      await expect(op("container.create", { desired: { ...desired, secrets } })).rejects.toThrow(
        "no SANOMA_DATABASE_URL among its secrets",
      );
      await expect(
        op("container.create", { desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: "mysql://db/company" })),
      ).rejects.toMatchObject({ vendorCode: "invalid", message: expect.not.stringContaining("mysql://") });
      // A password with a malformed escape.
      await expect(
        op(
          "container.create",
          { desired },
          callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: "postgres://u:50%zz@db/x" }),
        ),
      ).rejects.toMatchObject({ vendorCode: "invalid", message: expect.not.stringContaining("50%zz") });
      expect(sent).toEqual([]);
    });

    it("plans an update when a domain the Worker serves is not attached, so the next apply attaches it", async () => {
      const [settings, ...rest] = only("update", (_, i) => i < 3);
      play("domain-unattached", [
        withText(settings!, "SANOMA_DOMAINS", "www=www.acme.example"),
        ...rest,
        attachedDomains(),
      ]);
      const domains = { www: "www.acme.example" };
      const planned = await op("container.plan", { id: "company", desired: { ...desired, domains } });
      expect(planned).toMatchObject({ action: "update", planned: { domains } });
    });

    it("refuses a domain whose zone the account does not hold, naming both, before anything changes", async () => {
      const noZone = reply(`/client/v4/zones?name=other.example&account.id=${TEST_ACCOUNT}`, 200, {
        ...cfResult([]),
        result_info: { page: 1, per_page: 20, count: 0, total_count: 0, total_pages: 0 },
      });
      play("no-zone", [...only("create", (_, i) => i < 2), noZone]);
      await expect(
        op("container.create", { desired: { ...desired, domains: { www: "www.other.example" } } }),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        vendorCode: "no_zone",
        message: expect.stringMatching(/no zone other\.example for the domain www\.other\.example/),
      });
      expect(sent.some((r) => r.method !== "GET")).toBe(false);
    });

    it("plans an update when the declaration leaves out the domains the Worker serves", async () => {
      const [settings, ...rest] = only("update", (_, i) => i < 3);
      play("domains-removed", [
        withText(settings!, "SANOMA_DOMAINS", "www=acme.example"),
        ...rest,
        attachedDomains("acme.example"),
      ]);
      const planned = (await op("container.plan", { id: "company", desired })) as {
        action: string;
        planned: Record<string, unknown>;
      };
      expect(planned.action).toBe("update");
      expect(planned.planned).not.toHaveProperty("domains");
    });

    it("attaches the declared hostname like a domain, serves the app there as its url, and detaches it at delete", async () => {
      const hostname = "app.acme.example";
      play("hostname");
      // The Worker's health is asked on workers.dev: the hostname's certificate may not be ready yet.
      server.use(http.all(`https://${hostname}/*`, () => HttpResponse.error()));
      const made = (await op("container.create", { desired: { ...desired, hostname } })) as {
        state: Record<string, unknown>;
      };
      expect(made).toEqual({ id: "company", state: { ...state, hostname, url: `https://${hostname}` } });
      // The host's outputs: the app at its hostname, the wakeup on workers.dev.
      expect(container.host!.outputs(made.state)).toEqual({
        url: `https://${hostname}`,
        wakeUrl: URL_OF,
        revision: "abc123",
        healthy: true,
      });
      const attached = sent.find((r) => r.method === "PUT" && r.path === apiPath("/workers/domains"));
      expect(attached!.body).toEqual({ hostname, service: "sanoma-company", zone_id: ZONE });
      const { bindings } = await uploaded();
      const text = Object.fromEntries(
        (bindings as { name: string; text?: string }[]).map((b) => [b.name, b.text] as const),
      );
      // The wakeup reaches the Worker on workers.dev, whatever hostname it serves.
      expect(text).toMatchObject({ SANOMA_HOST_URL: URL_OF, SANOMA_HOSTNAME: hostname });
      expect(text).not.toHaveProperty("SANOMA_DOMAINS");
      expect(await op("container.delete", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(sent.filter((r) => r.method === "DELETE" && r.path.includes("/workers/domains/"))).toHaveLength(1);
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: true });
    });

    it("reads the hostname detached by hand as drift, and plans the update that attaches it again at its url", async () => {
      const [settings, ...rest] = only("update", (_, i) => i < 3);
      play("hostname-unattached", [
        withText(settings!, "SANOMA_HOSTNAME", "app.acme.example"),
        ...rest,
        attachedDomains(),
      ]);
      const planned = await op("container.plan", {
        id: "company",
        desired: { ...desired, hostname: "app.acme.example" },
      });
      expect(planned).toMatchObject({ action: "update", planned: { hostname: "app.acme.example" } });
      expect((planned as { planned: { url: string } }).planned.url).toBe("https://app.acme.example");
    });

    it("detaches a renamed hostname before the upload and attaches the new one after it, the app at the new one", async () => {
      const updated = fixture("update");
      play("hostname-rename", [...renameUntilUpload(updated), updated[12]!, attachedNew, ...updated.slice(13)]);
      expect(await update({ desired: renamed })).toEqual({ id: "company", state: renamedState });
      // Detached while the bindings still name it; attached once they name the new one.
      expect(requests().filter((r) => /^(PUT|DELETE) \/workers\/(domains|scripts\/sanoma-company)/.test(r))).toEqual([
        "DELETE /workers/domains/d1",
        "PUT /workers/scripts/sanoma-company",
        "PUT /workers/domains",
      ]);
      expect(sent.find((r) => r.method === "PUT" && r.path === apiPath("/workers/domains"))!.body).toEqual({
        hostname: "new.acme.example",
        service: "sanoma-company",
        zone_id: ZONE,
      });
      const { bindings } = await uploaded();
      expect(bindings).toContainEqual({ type: "plain_text", name: "SANOMA_HOSTNAME", text: "new.acme.example" });
    });

    it("converges on a retry after a rename fails past the detach: the old name gone, the new one attached and recorded", async () => {
      const updated = fixture("update");
      const uploadRefused = reply(
        apiPath("/workers/scripts/sanoma-company"),
        400,
        cfError(10021, "Uncaught Error: the upload failed"),
        "PUT",
      );
      // The retry finds the bindings naming the old hostname, which is no longer attached.
      const settings = withText(updated[0]!, "SANOMA_HOSTNAME", "old.acme.example");
      play("hostname-rename-retried", [
        ...renameUntilUpload(updated),
        uploadRefused,
        settings,
        updated[1]!,
        attachedDomains(),
        withText(updated[3]!, "SANOMA_HOSTNAME", "old.acme.example"),
        attachedDomains(),
        zoneLookup(),
        ...updated.slice(4, 13),
        attachedNew,
        ...updated.slice(13),
      ]);
      await expect(update({ desired: renamed })).rejects.toMatchObject({ name: "DriverError", status: 400 });
      // Nothing attached that the bindings do not name: the old hostname is gone, the new one not attached yet.
      expect(requests().filter((r) => r.includes("/workers/domains/") || r === "PUT /workers/domains")).toEqual([
        "DELETE /workers/domains/d1",
      ]);
      const retried = sent.length;
      expect(await update({ desired: renamed })).toEqual({ id: "company", state: renamedState });
      // No detach the second time: the old name is not attached; the new one is, after the upload.
      expect(
        requests(retried).filter((r) => /^(PUT|DELETE) \/workers\/(domains|scripts\/sanoma-company)/.test(r)),
      ).toEqual(["PUT /workers/scripts/sanoma-company", "PUT /workers/domains"]);
    });

    it("attaches a site's new domain only after the upload names it, so it never reaches a Worker that would serve the app there", async () => {
      const updated = fixture("update");
      play("domain-added-fails", [
        ...updated.slice(0, 4),
        attachedDomains(),
        zoneLookup(),
        ...updated.slice(4, 13),
        attachRefused,
      ]);
      const withSite = { ...desired, revision: "def456", domains: { www: "www.acme.example" } };
      await expect(
        op("container.update", { id: "company", desired: withSite, expect: { action: "update", replace: [] } }),
      ).rejects.toMatchObject({ name: "DriverError", status: 409 });
      const puts = sent.filter((r) => r.method === "PUT" && !r.path.includes("/hyperdrive/")).map((r) => r.path);
      expect(puts).toEqual([apiPath("/workers/scripts/sanoma-company"), apiPath("/workers/domains")]);
    });

    it("plans an update when the declaration leaves out the hostname the Worker serves", async () => {
      const [settings, ...rest] = only("update", (_, i) => i < 3);
      play("hostname-removed", [
        withText(settings!, "SANOMA_HOSTNAME", "app.acme.example"),
        ...rest,
        attachedDomains("app.acme.example"),
      ]);
      const planned = (await op("container.plan", { id: "company", desired })) as {
        action: string;
        planned: Record<string, unknown>;
      };
      // Planned back on workers.dev, so a wakeup on the host is planned to follow it.
      expect(planned.action).toBe("update");
      expect(planned.planned.url).toBe(URL_OF);
      expect(planned.planned).not.toHaveProperty("hostname");
    });

    it("refuses a hostname that is also a site's domain, invalid, at plan and at create, before any request", async () => {
      const both = { ...desired, hostname: "www.acme.example", domains: { www: "www.acme.example" } };
      const invalid = {
        name: "DriverError",
        retryable: false,
        vendorCode: "invalid",
        message: expect.stringContaining("hostname www.acme.example is also the domain of the site www"),
      };
      await expect(op("container.plan", { id: "company", desired: both })).rejects.toMatchObject(invalid);
      await expect(op("container.create", { desired: both })).rejects.toMatchObject(invalid);
      expect(sent).toEqual([]);
    });

    it("refuses a secret named as one of the Worker's own bindings, without calling Cloudflare", async () => {
      const call = callWith({ X: "y" });
      await expect(
        op("container.create", { desired: { ...desired, secrets: { PORT: { $secret: "X" } } } }, call),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: expect.stringContaining("PORT is the Worker's own"),
      });
      expect(sent).toEqual([]);
    });

    it("fails retryably when the container is not restarted at the revision in its own time, saying what it runs", async () => {
      const slow = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 30, pollMs: 5 });
      play(
        "stale",
        only("create", (e) => e.path !== "/__sanoma/health?start=1"),
      );
      server.use(
        http.get("*/__sanoma/health", ({ request }) => restart(request, HttpResponse.json({ revision: "older" }))),
      );
      await expect(
        slow.ops["container.create"]!({ desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: DATABASE_URL })),
      ).rejects.toMatchObject({
        name: "DriverError",
        // The upload is made: the next apply plans none, and waits for the restart alone.
        retryable: true,
        message: expect.stringContaining("still starting at abc123 after 0 s: it runs older"),
      });
    });

    it("stops waiting when the Worker says its container ended, as asking again would start it again", async () => {
      const patient = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 60_000, pollMs: 5 });
      play(
        "stale",
        only("create", (e) => e.path !== "/__sanoma/health?start=1"),
      );
      server.use(
        http.get("*/__sanoma/health", ({ request }) =>
          restart(
            request,
            HttpResponse.json(
              {
                error: "the company's container did not start: the container failed: exit code 1",
                exit: "the container failed: exit code 1",
              },
              { status: 503 },
            ),
          ),
        ),
      );
      const t0 = Date.now();
      await expect(
        patient.ops["container.create"]!({ desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, DB_URL: DATABASE_URL })),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: expect.stringContaining(
          "did not start at abc123: the company's container did not start: the container failed: exit code 1",
        ),
      });
      expect(Date.now() - t0).toBeLessThan(10_000);
    });

    it.each([
      [403, 10000, false],
      [429, 971, true],
      [500, 10013, true],
    ])("fails a %i with Cloudflare's status and first error code, retryable: %s", async (status, code, retryable) => {
      play("failed", [reply(apiPath("/workers/scripts/sanoma-company/settings"), status, cfError(code, "it failed"))]);
      await expect(op("container.read", { id: "company" })).rejects.toMatchObject({
        name: "DriverError",
        retryable,
        status,
        vendorCode: String(code),
        message: `cloudflare: GET workers/scripts/sanoma-company/settings answered ${status}: it failed`,
      });
    });

    it("fails a request with no reply in time as retryable", async () => {
      play("timeout", []);
      server.use(
        http.get("*/settings", async () => {
          await delay(1_000);
          return HttpResponse.json({});
        }),
      );
      await expect(op("container.read", { id: "company" })).rejects.toMatchObject({
        name: "DriverError",
        retryable: true,
        message: "cloudflare: GET workers/scripts/sanoma-company/settings: no reply in 200 ms",
      });
    });

    it("refuses at the call without credentials, naming what the token needs", async () => {
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
      await expect(op("container.read", { id: "company" })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: expect.stringContaining("CLOUDFLARE_API_TOKEN is not set (an API token with Workers Scripts Edit"),
      });
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
      await expect(op("container.read", { id: "company" })).rejects.toMatchObject({
        message: expect.stringContaining("CLOUDFLARE_ACCOUNT_ID is not set"),
      });
      expect(sent).toEqual([]);
    });
  });

  describe("cloudflare.alarm", () => {
    it("creates the alarm of a host that holds the token, storing the token and the host's URL", async () => {
      const call = callWith();
      play("alarm", [wake(200, { at: null })]);
      const made = await op("alarm.create", { desired: { host: `${URL_OF}/` } }, call);
      expect(made).toEqual({ id: URL_OF, state: { host: URL_OF, at: null, rang: null, healthy: true } });
      const token = await call.secrets.get("SANOMA_WAKEUP_TOKEN");
      expect(token).toMatch(/^swi_/);
      expect(await call.secrets.get("SANOMA_HOST_URL")).toBe(URL_OF);
      expect(sent[0]!.headers.get("authorization") === `Bearer ${token}`).toBe(true);
    });

    it("refuses an alarm for a host without the token, and one with another", async () => {
      play("no-token", [
        wake(404, { error: "SANOMA_WAKEUP_TOKEN is not set on this Worker" }),
        wake(401, { error: "not this company's token" }),
      ]);
      await expect(op("alarm.create", { desired: { host: URL_OF } })).rejects.toMatchObject({ vendorCode: "no_token" });
      await expect(op("alarm.create", { desired: { host: URL_OF } })).rejects.toMatchObject({ vendorCode: "token" });
    });

    it("refuses an alarm where no Worker of Sanoma's answers", async () => {
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN });
      play("no-worker", [wake(404, "There is nothing here yet")]);
      await expect(op("alarm.create", { desired: { host: URL_OF } }, call)).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 404,
        message: expect.stringContaining("apply the host first"),
      });
      // Nothing stored for a host that did not answer.
      expect(await call.secrets.get("SANOMA_HOST_URL")).toBeUndefined();
    });

    it("reads the alarm of a host without the stored token as unhealthy, so a plan to delete it goes on", async () => {
      play("no-stored-token", [wake(401, { error: "the token is not this host's SANOMA_WAKEUP_TOKEN" })]);
      expect(await op("alarm.read", { id: URL_OF }, callWith())).toEqual({
        id: URL_OF,
        gone: false,
        state: { host: URL_OF, at: null, rang: null, healthy: false },
      });
    });

    it("refuses to plan a declared alarm under a token of its own, without a request", async () => {
      const own = { host: URL_OF, token: { $secret: "CLOUD_ACME_WAKEUP_TOKEN" } };
      await expect(op("alarm.plan", { desired: own })).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("leave token out of the data file"),
      });
      expect(sent).toEqual([]);
    });

    it("registers a wake at the stored host's wake route, with the token", async () => {
      play("register-only", [wake(204, null, "PUT")]);
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, SANOMA_HOST_URL: URL_OF });
      expect(await op("alarm.register", { at: "2099-01-01T00:00:00Z" }, call)).toEqual({});
      expect(sent[0]!.body).toEqual({ at: "2099-01-01T00:00:00Z" });
      expect(sent[0]!.headers.get("authorization") === `Bearer ${TOKEN}`).toBe(true);
    });

    it("refuses to register with no stored host's URL, whatever the environment holds, without a request", async () => {
      vi.stubEnv("SANOMA_HOST_URL", URL_OF);
      await expect(
        op("alarm.register", { at: "2099-01-01T00:00:00Z" }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN })),
      ).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("SANOMA_HOST_URL is not stored"),
      });
      expect(sent).toEqual([]);
    });

    it("stores a new host's URL over an earlier host's", async () => {
      const call = callWith({ SANOMA_HOST_URL: "https://elsewhere.example.workers.dev" });
      play("alarm-new-host", [wake(200, { at: null })]);
      await op("alarm.create", { desired: { host: URL_OF } }, call);
      expect(await call.secrets.get("SANOMA_HOST_URL")).toBe(URL_OF);
    });

    it("fails a register the Worker could not take as retryable", async () => {
      play("register-failed", [wake(503, { error: "storage is not available" }, "PUT")]);
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, SANOMA_HOST_URL: URL_OF });
      await expect(op("alarm.register", { at: "2099-01-01T00:00:00Z" }, call)).rejects.toMatchObject({
        retryable: true,
        status: 503,
        message: `cloudflare: PUT ${URL_OF}/__sanoma/wake: storage is not available`,
      });
    });

    it("deletes the wake, and a host that is gone counts as deleted", async () => {
      play("alarm-delete", [wake(204, null, "DELETE"), wake(404, "There is nothing here yet", "DELETE")]);
      expect(await op("alarm.delete", { id: URL_OF })).toEqual({ id: URL_OF, gone: true });
      expect(await op("alarm.delete", { id: URL_OF })).toEqual({ id: URL_OF, gone: true });
    });

    it("asks a host to delete its wake without the stored token too: gone counts, a refusal fails", async () => {
      play("alarm-delete-without-token", [
        wake(404, "There is nothing here yet", "DELETE"),
        wake(401, { error: "the token is not this host's SANOMA_WAKEUP_TOKEN" }, "DELETE"),
      ]);
      expect(await op("alarm.delete", { id: URL_OF }, callWith())).toEqual({ id: URL_OF, gone: true });
      await expect(op("alarm.delete", { id: URL_OF }, callWith())).rejects.toMatchObject({
        retryable: false,
        status: 401,
      });
      expect(sent.map((r) => r.headers.get("authorization"))).toEqual(["Bearer", "Bearer"]);
    });
  });
});
