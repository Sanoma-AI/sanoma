import { type Exchange, live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareDriver } from "../src/driver.ts";
import { API, replayOptions } from "./replay.ts";

// Replays test/fixtures, written from Cloudflare's API reference (README, "Testing the driver").
// Live, `test/live.ts` and the features run against an account instead: these tests check the
// requests the driver makes and how it reads made-up replies.

const { server, play, fixture, sent } = replay(replayOptions);

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
  image: "docker.io/sanomaai/runtime:0.7.0",
  source: "https://github.com/acme/company.git",
  ref: "main",
  revision: "abc123",
  port: 3000,
  secrets: { SANOMA_WAKEUP_TOKEN: { $secret: "SANOMA_WAKEUP_TOKEN" } },
};
const state = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "company",
  image: "docker.io/sanomaai/runtime:0.7.0",
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

describe.skipIf(live)("cloudflareDriver", () => {
  describe("cloudflare.container", () => {
    it("uploads the Worker with its bindings and migration, turns its URL on, makes its application and waits for it", async () => {
      play("create");
      const made = await op("container.create", { desired });
      expect(made).toEqual({ id: "company", state });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`)).toEqual([
        "GET /workers/subdomain",
        "GET /workers/scripts/sanoma-company/settings",
        "PUT /workers/scripts/sanoma-company",
        "POST /workers/scripts/sanoma-company/subdomain",
        "GET /containers/applications?name=sanoma-company",
        "POST /containers/applications",
        "GET /__sanoma/health",
      ]);
      // Compared, not printed: a failure must not show a live token.
      expect(sent.slice(0, 6).every((r) => r.headers.get("authorization") === "Bearer test-token")).toBe(true);

      const upload = sent[2]!;
      expect(upload.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const form = await formOf(upload);
      expect(form.get("metadata[main_module]")).toBe("index.js");
      expect(form.get("metadata[compatibility_date]")).toBe("2026-10-01");
      expect(form.get("metadata[migrations][new_tag]")).toBe("v1");
      expect(form.getAll("metadata[migrations][new_sqlite_classes][]")).toEqual(["SanomaInstance"]);
      expect(form.getAll("metadata[bindings][][name]")).toEqual([
        "SANOMA_INSTANCE",
        "SANOMA_SOURCE",
        "SANOMA_REF",
        "SANOMA_REVISION",
        "PORT",
        "SANOMA_HOST_URL",
        "SANOMA_WAKEUP_TOKEN",
      ]);
      expect(form.getAll("metadata[bindings][][text]")).toContain(URL_OF);
      // The secret goes as a secret binding, resolved at the call.
      expect(form.getAll("metadata[bindings][][type]").at(-1)).toBe("secret_text");
      expect(form.getAll("metadata[bindings][][text]").at(-1)).toBe(TOKEN);
      const files = form.getAll("files[]") as File[];
      expect(files.map((f) => [f.name, f.type])).toEqual([
        ["index.js", "application/javascript+module"],
        ["instance.js", "application/javascript+module"],
      ]);
      expect(await files[0]!.text()).toContain('from "cloudflare:workers"');

      expect(sent[3]!.body).toEqual({ enabled: true });
      expect(sent[5]!.body).toEqual({
        name: "sanoma-company",
        scheduling_policy: "default",
        instances: 0,
        max_instances: 1,
        configuration: { image: "docker.io/sanomaai/runtime:0.7.0", instance_type: "basic" },
        durable_objects: { script_name: "sanoma-company", class_name: "SanomaInstance" },
      });
    });

    it("rolls a new image out without the migration, and polls until the Worker answers at the new revision", async () => {
      play("update-to-a-new-image");
      const next = { ...desired, image: "docker.io/sanomaai/runtime:0.8.0", revision: "def456" };
      const done = await op("container.update", {
        id: "company",
        desired: next,
        expect: { action: "update", replace: [] },
      });
      expect(done).toEqual({ id: "company", state: { ...state, image: next.image, revision: "def456" } });
      const form = await formOf(sent.find((r) => r.method === "PUT")!);
      expect(form.get("metadata[migrations][new_tag]")).toBeNull();
      expect(sent.find((r) => r.path.endsWith("/rollouts"))!.body).toEqual({
        description: "Sanoma: docker.io/sanomaai/runtime:0.8.0",
        strategy: "rolling",
        kind: "full_auto",
        step_percentage: 100,
        target_configuration: { image: "docker.io/sanomaai/runtime:0.8.0", instance_type: "basic" },
      });
      expect(sent.filter((r) => r.path === "/__sanoma/health")).toHaveLength(2);
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

    it("reads what the Worker runs from its bindings, and no secret's value", async () => {
      play("read-only", [
        ...only("update-to-a-new-image", (_, i) => i < 3),
        reply("/__sanoma/health", 200, { revision: "abc123" }),
      ]);
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
        only("delete", (_, i) => i >= 7 && i < 10),
      );
      expect(await op("container.delete", { id: "company" })).toEqual({ id: "company", gone: true });
      expect(sent.map((r) => `${r.method} ${r.path.replace(API, "")}`)).toEqual([
        "GET /containers/applications?name=sanoma-company",
        "DELETE /containers/applications/00000000-0000-4000-8000-000000000001",
        "DELETE /workers/scripts/sanoma-company?force=true",
      ]);
    });

    it("refuses to overwrite a Worker of that name that is not Sanoma's", async () => {
      play("not-ours", [
        ...only("create", (_, i) => i === 0),
        reply(apiPath("/workers/scripts/sanoma-company/settings"), 200, {
          success: true,
          errors: [],
          messages: [],
          result: { bindings: [{ type: "plain_text", name: "GREETING", text: "hello" }] },
        }),
      ]);
      await expect(op("container.create", { desired })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        vendorCode: "exists",
      });
      expect(sent.some((r) => r.method === "PUT")).toBe(false);
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
        only("create", (e) => e.path !== "/__sanoma/health"),
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
      play("alarm", [wake(200, { at: null, generation: 0 })]);
      const made = await op("alarm.create", { desired: { host: `${URL_OF}/` } }, call);
      expect(made).toEqual({ id: URL_OF, state: { host: URL_OF, at: null, generation: 0, healthy: true } });
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
      play("no-worker", [wake(404, "There is nothing here yet")]);
      await expect(op("alarm.create", { desired: { host: URL_OF } })).rejects.toMatchObject({
        name: "DriverError",
        retryable: false,
        status: 404,
        message: expect.stringContaining("apply the host first"),
      });
    });

    it("refuses an alarm for another host than the one stored", async () => {
      const call = callWith({ SANOMA_HOST_URL: "https://sanoma-other.example.workers.dev" });
      await expect(op("alarm.create", { desired: { host: URL_OF } }, call)).rejects.toMatchObject({
        vendorCode: "stale",
      });
      expect(sent).toEqual([]);
    });

    it("registers a wake at the stored host's wake route, with the token", async () => {
      play("register-only", [wake(204, null, "PUT")]);
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, SANOMA_HOST_URL: URL_OF });
      expect(await op("alarm.register", { at: "2099-01-01T00:00:00Z", generation: 3 }, call)).toEqual({});
      expect(sent[0]!.body).toEqual({ at: "2099-01-01T00:00:00Z", generation: 3 });
      expect(sent[0]!.headers.get("authorization") === `Bearer ${TOKEN}`).toBe(true);
    });

    it("refuses to register before the alarm stored the host's URL, without a request", async () => {
      await expect(op("alarm.register", { at: "2099-01-01T00:00:00Z", generation: 1 })).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("SANOMA_HOST_URL is not set"),
      });
      expect(sent).toEqual([]);
    });

    it("fails a register the Worker could not take as retryable", async () => {
      play("register-failed", [wake(503, { error: "storage is not available" }, "PUT")]);
      const call = callWith({ SANOMA_WAKEUP_TOKEN: TOKEN, SANOMA_HOST_URL: URL_OF });
      await expect(op("alarm.register", { at: "2099-01-01T00:00:00Z", generation: 1 }, call)).rejects.toMatchObject({
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
  });
});
