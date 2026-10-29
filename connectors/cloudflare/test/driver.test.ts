import { createHash } from "node:crypto";
import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareDriver } from "../src/driver.ts";
import { API, replayOptions, TEST_ACCOUNT } from "./replay.ts";

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
const op = (name: string, input: object, call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN })) =>
  driver.ops[name]!(input, call);

const desired = {
  name: "company",
  image: PINNED,
  source: "https://github.com/acme/company.git",
  ref: "main",
  revision: "abc123",
  port: 3000,
  secrets: { SANOMA_WAKEUP_TOKEN: { $secret: "SANOMA_WAKEUP_TOKEN" } },
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
  healthy: true,
};

/** The exchanges of `name` that match `keep`. */
const only = (name: string, keep: (e: Exchange, i: number) => boolean) => fixture(name).filter(keep);
const apiPath = (path: string) => `${API}${path}`;
const reply = (path: string, status: number, body: unknown, method = "GET"): Exchange => ({
  method,
  path,
  status,
  body,
});
const wake = (status: number, body: unknown, method = "GET") => reply("/__sanoma/wake", status, body, method);
const cfResult = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const cfError = (code: number, message: string) => ({
  success: false,
  errors: [{ code, message }],
  messages: [],
  result: null,
});

/** The upload's form, as Cloudflare reads it. */
async function formOf(request: (typeof sent)[number]) {
  return new Response(request.body as string, {
    headers: { "content-type": request.headers.get("content-type")! },
  }).formData();
}
/** The metadata of the upload among the requests sent. */
async function uploaded() {
  const form = await formOf(sent.find((r) => r.method === "PUT" && r.path.startsWith(API))!);
  return JSON.parse(await (form.get("metadata") as File).text());
}

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
        "PUT /workers/scripts/sanoma-company",
        "POST /workers/scripts/sanoma-company/subdomain",
        "GET /containers/applications?name=sanoma-company",
        "GET /workers/scripts/sanoma-company/settings",
        "POST /containers/applications",
        // Again, once the application exists: the object's namespace learns it from this deployment.
        "PUT /workers/scripts/sanoma-company",
        "GET /__sanoma/health?start=1",
      ]);
      // Compared, not printed: a failure must not show a live token.
      expect(sent.slice(0, 10).every((r) => r.headers.get("authorization") === "Bearer test-token")).toBe(true);
      const again = JSON.parse(await ((await formOf(sent[9]!)).get("metadata") as File).text());
      expect(again.migrations).toBeUndefined();
      expect(sent[2]!.body).toEqual({ image: PINNED });

      const upload = sent[4]!;
      expect(upload.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const form = await formOf(upload);
      // One `metadata` part, the JSON, as Cloudflare reads it; the modules as parts named after them.
      const metadata = JSON.parse(await (form.get("metadata") as File).text());
      expect(metadata.main_module).toBe("index.js");
      expect(metadata.compatibility_date).toBe("2026-10-01");
      expect(metadata.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["SanomaInstance"] });
      // Its object runs a container (without this, it has no `ctx.container`), at the pinned image it names.
      expect(metadata.containers).toEqual([
        { name: "sanoma-company", class_name: "SanomaInstance", images: { runtime: PINNED } },
      ]);
      expect(metadata.bindings.map((b: { name: string }) => b.name)).toEqual([
        "SANOMA_INSTANCE",
        "SANOMA_SOURCE",
        "SANOMA_REF",
        "SANOMA_REVISION",
        "SANOMA_IMAGE",
        "PORT",
        "SANOMA_HOST_URL",
        "SANOMA_WAKEUP_TOKEN",
      ]);
      expect(metadata.bindings.map((b: { text?: string }) => b.text)).toContain(URL_OF);
      // The secret goes as a secret binding, resolved at the call.
      expect(metadata.bindings.at(-1)).toMatchObject({ type: "secret_text", text: TOKEN });
      const files = ["index.js", "instance.js"].map((name) => form.get(name) as File);
      expect(files.map((f) => [f.name, f.type])).toEqual([
        ["index.js", "application/javascript+module"],
        ["instance.js", "application/javascript+module"],
      ]);
      expect(await files[0]!.text()).toContain('from "cloudflare:workers"');

      expect(sent[5]!.body).toEqual({ enabled: true });
      // The policy's whole body: the image and the instance type are the object's.
      expect(sent[8]!.body).toEqual({
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
      expect(sent.filter((r) => r.path === "/__sanoma/health?start=1")).toHaveLength(2);
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

    it("plans nothing for a ghcr.io image the Worker names, whose copy the application runs", async () => {
      // The Worker's `SANOMA_IMAGE` binding holds the declared image; the application its copy.
      play(
        "plan-the-copy",
        only("update-to-a-new-image", (_, i) => i < 3).map((exchange) =>
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
        only("update-to-a-new-image", (_, i) => i < 3),
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
        only("update-to-a-new-image", (_, i) => i < 3),
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
        ...only("update-to-a-new-image", (_, i) => i < 3),
        reply("/__sanoma/health", 200, { revision: "abc123", running: false }),
      ]);
      // Stopped is healthy: the read asks without starting it.
      expect(await op("container.read", { id: "company" })).toEqual({ id: "company", gone: false, state });
    });

    it("reads a Worker whose container does not answer as unhealthy", async () => {
      play("unhealthy", [
        ...only("update-to-a-new-image", (_, i) => i < 3),
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

    it("deletes the application, then the Worker with its object's storage", async () => {
      play(
        "delete-only",
        only("delete", (_, i) => i >= 10 && i < 14),
      );
      expect(await op("container.delete", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`)).toEqual([
        "GET /workers/scripts/sanoma-company/settings",
        "GET /containers/applications?name=sanoma-company",
        "DELETE /containers/applications/00000000-0000-4000-8000-000000000001",
        "DELETE /workers/scripts/sanoma-company?force=true",
      ]);
    });

    it("leaves a Worker of that name that is not Sanoma's alone: reads it as gone, refuses to overwrite or delete it", async () => {
      const foreign = reply(apiPath("/workers/scripts/sanoma-company/settings"), 200, {
        success: true,
        errors: [],
        messages: [],
        result: { bindings: [{ type: "plain_text", name: "GREETING", text: "hello" }] },
      });
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

    it("plans an update when the declaration leaves out the domains the Worker serves", async () => {
      const [settings, ...rest] = only("update-to-a-new-image", (_, i) => i < 3);
      const body = structuredClone(settings!.body) as { result: { bindings: object[] } };
      body.result.bindings.push({ type: "plain_text", name: "SANOMA_DOMAINS", text: "www=acme.example" });
      play("domains-removed", [{ ...settings!, body }, ...rest]);
      expect(await op("container.plan", { id: "company", desired })).toMatchObject({ action: "update" });
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

    it("fails when the Worker does not answer at the revision in time, saying what it answered", async () => {
      const slow = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 30, pollMs: 5 });
      play(
        "stale",
        only("create", (e) => !e.path.startsWith("/__sanoma/health")),
      );
      server.use(http.get("*/__sanoma/health", () => HttpResponse.json({ revision: "older" })));
      await expect(
        slow.ops["container.create"]!({ desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN })),
      ).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        message: expect.stringContaining("did not answer at abc123 in 0 s: it runs older"),
      });
    });

    it("stops waiting when the Worker says its container ended, as asking again would start it again", async () => {
      const patient = cloudflareDriver({ timeoutMs: 200, startTimeoutMs: 60_000, pollMs: 5 });
      play(
        "stale",
        only("create", (e) => !e.path.startsWith("/__sanoma/health")),
      );
      server.use(
        http.get("*/__sanoma/health", () =>
          HttpResponse.json(
            {
              error: "the company's container did not start: the container failed: exit code 1",
              exit: "the container failed: exit code 1",
            },
            { status: 503 },
          ),
        ),
      );
      const t0 = Date.now();
      await expect(
        patient.ops["container.create"]!({ desired }, callWith({ SANOMA_WAKEUP_TOKEN: TOKEN })),
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

    it("registers a wake at the stored host's wake route, with the token", async () => {
      play("register-only", [wake(204, null, "PUT")]);
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, SANOMA_HOST_URL: URL_OF });
      expect(await op("alarm.register", { at: "2099-01-01T00:00:00Z" }, call)).toEqual({});
      expect(sent[0]!.body).toEqual({ at: "2099-01-01T00:00:00Z" });
      expect(sent[0]!.headers.get("authorization") === `Bearer ${TOKEN}`).toBe(true);
    });

    it("refuses to register before the alarm stored the host's URL, without a request", async () => {
      await expect(op("alarm.register", { at: "2099-01-01T00:00:00Z" })).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("SANOMA_HOST_URL is not set"),
      });
      expect(sent).toEqual([]);
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
