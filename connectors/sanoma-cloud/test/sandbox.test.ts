import { readFileSync } from "node:fs";
import { BOX_INPUTS, boxProblem } from "@sanoma-ai/connector-sanoma-cloud/boxes";
import { checkSandbox } from "sanoma/testing/sandbox";
import { type CallContext, memorySecrets, RUNNER_PROTOCOL } from "sanoma/workflows";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cloudBackend } from "../src/backend.ts";
import { sandbox } from "../src/connector.ts";
import { BOXES_BUSY, fakeCloud } from "../src/fake.ts";
import type { CloudApi } from "../src/operations.ts";

// `cloud.sandbox`'s backend: the Sandbox contract's conformance kit over the fake Cloud's boxes,
// which run Sanoma's runner on this machine; what it starts at the Cloud, and what it refuses
// before it starts anything; and the declaration bound to the company.

/** The id the fake gives the token's company. */
const COMPANY = "fake-company-1";
const HOSTS = ["registry.npmjs.org", "api.anthropic.com"];

const fake = fakeCloud({ slug: "acme" });
afterEach(() => fake.reset());
afterAll(() => fake.close());

let n = 0;
const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${++n}`,
  runId: "sandbox",
  opId,
  attempt: 1,
  secrets: memorySecrets(),
});
const op = (name: string, input: object) => fake.driver.ops[name]!(input, call(`cloud.${name}`)) as Promise<any>;

/** A Cloud that records which box workflows were started, with what, and answers what `answers` gives. */
function stubCloud(answers: Partial<CloudApi> = {}) {
  const started: [string, unknown][] = [];
  const workflow =
    (method: "boxOpen" | "boxExpose" | "boxStop" | "boxDiscard") =>
    async (input: never): Promise<never> => {
      started.push([method, input]);
      return ((await answers[method]?.(input)) ?? {}) as never;
    };
  const api = {
    boxOpen: workflow("boxOpen"),
    boxExpose: workflow("boxExpose"),
    boxStop: workflow("boxStop"),
    boxDiscard: workflow("boxDiscard"),
  } as unknown as CloudApi;
  return { api, started };
}

/** A box at a runner no one listens on: its commands fail, its stop kills nothing. */
const nowhere = (protocol = RUNNER_PROTOCOL) => ({
  boxOpen: async () => ({ id: "i1", url: "http://127.0.0.1:9/?a37_token=t", protocol }),
});

describe("cloud.sandbox's backend", () => {
  it("exports the box input rules from an entry of their own, which imports no driver", () => {
    const { exports } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(exports["./boxes"]).toEqual({ types: "./dist/boxes.d.ts", default: "./dist/boxes.js" });
    const source = readFileSync(new URL("../src/boxes.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1])).toEqual(["zod"]);
    expect(boxProblem(BOX_INPUTS.open, { name: "sanoma-acme-ada", hosts: HOSTS })).toBeUndefined();
    expect(boxProblem(BOX_INPUTS.open, { name: "Ada", hosts: [] })).toBe(
      "name is no box name: lowercase letters, digits, - and _; hosts Too small: expected array to have >=1 items",
    );
    expect(boxProblem(BOX_INPUTS.name, { name: "a/b" })).toMatch(/^name is no box name/);
  });

  it("passes the sandbox conformance kit on the fake Cloud", async () => {
    const results = await checkSandbox({
      backend: fake.sandbox(),
      capabilities: sandbox.sandbox!.capabilities,
      timeoutMs: 20_000,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(9);
  });

  it("refuses, before any workflow starts, a name or hosts the Cloud would refuse", async () => {
    const { api, started } = stubCloud(nowhere());
    const backend = cloudBackend(api);
    const many = Array.from({ length: 101 }, (_, i) => `h${i}.example.com`);
    for (const hosts of [[], many, ["10.0.0.1"], ["169.254.169.254"], ["*"], ["*.com"], ["localhost"], ["a b.com"]]) {
      await expect(backend.open({ name: "sanoma-acme-ada", hosts }), hosts.join()).rejects.toMatchObject({
        vendorCode: "invalid_box",
        retryable: false,
      });
    }
    for (const name of ["", "Ada", "../x", "a/b", "a".repeat(201)]) {
      await expect(backend.open({ name, hosts: HOSTS }), name).rejects.toMatchObject({ vendorCode: "invalid_box" });
      await expect(backend.discard({ name }), name).rejects.toMatchObject({ vendorCode: "invalid_box" });
    }
    expect(started).toEqual([]);
    // The hosts the app asks for, a subdomain wildcard among them (Copilot's), and a name it makes.
    await backend.open({ name: "sanoma-acme-ada%40example%2Ecom", hosts: [...HOSTS, "*.githubcopilot.com"] });
    expect(started).toEqual([
      ["boxOpen", { name: "sanoma-acme-ada%40example%2Ecom", hosts: [...HOSTS, "*.githubcopilot.com"] }],
    ]);
  });

  it("refuses a runner of another protocol than this release's, saying which side to update", async () => {
    await expect(
      cloudBackend(stubCloud(nowhere(RUNNER_PROTOCOL + 1)).api).open({ name: "a", hosts: HOSTS }),
    ).rejects.toThrow("update the company's sanoma package");
    await expect(
      cloudBackend(stubCloud(nowhere(RUNNER_PROTOCOL - 1)).api).open({ name: "a", hosts: HOSTS }),
    ).rejects.toThrow("Sanoma Cloud has not moved to this release yet");
  });

  it("kills what runs in the box at stop, then puts it to sleep, and sleeps one whose runner it cannot reach", async () => {
    const box = await fake.sandbox().open({ name: "a", hosts: HOSTS });
    const long = await box.run("sleep 30");
    await box.stop();
    expect((await long.wait()).exitCode).not.toBe(0);
    expect(Object.values(fake.state.boxes).map((b) => b.awake)).toEqual([false]);

    const { api, started } = stubCloud(nowhere());
    await (await cloudBackend(api).open({ name: "a", hosts: HOSTS })).stop();
    expect(started.map(([method]) => method)).toEqual(["boxOpen", "boxStop"]);
    expect(started[1]).toEqual(["boxStop", { name: "a" }]);
  });

  it("exposes a port through the link the Cloud answers, and discards through the Cloud", async () => {
    const { api, started } = stubCloud({
      ...nowhere(),
      boxExpose: async () => ({ url: "https://i1-3000.agent37.app/?a37_token=t2" }),
    });
    const backend = cloudBackend(api);
    const box = await backend.open({ name: "a", hosts: HOSTS });
    expect(await box.expose(3000)).toEqual({ url: "https://i1-3000.agent37.app/?a37_token=t2" });
    await backend.discard({ name: "a" });
    expect(started.slice(1)).toEqual([
      ["boxExpose", { name: "a", port: 3000 }],
      ["boxDiscard", { name: "a" }],
    ]);
  });

  it("fails with the Cloud's refusal as it is written for people", async () => {
    const busy = fakeCloud({ slug: "acme", awakeBoxes: 1 });
    try {
      await busy.sandbox().open({ name: "first", hosts: HOSTS });
      await expect(busy.sandbox().open({ name: "second", hosts: HOSTS })).rejects.toMatchObject({
        message: BOXES_BUSY,
        retryable: false,
      });
    } finally {
      await busy.close();
    }
  });

  it("is gone with the company's boxes when the company closes", async () => {
    await op("database.create", { desired: { region: "us-east" } });
    await (await fake.sandbox().open({ name: "a", hosts: HOSTS })).stop();
    await op("database.delete", { id: COMPANY });
    expect(fake.state.boxes).toEqual({});
    expect(() => fake.sandbox()).toThrow("the Cloud token is revoked");
  });
});

describe("cloud.sandbox's declaration", () => {
  it("binds the token's company, reads it while it is open, and makes nothing", async () => {
    expect(await op("sandbox.plan", { desired: {} })).toEqual({
      action: "create",
      planned: { id: COMPANY, healthy: null },
      unknown: ["healthy"],
      replace: [],
    });
    expect(await op("sandbox.create", { desired: {} })).toEqual({ id: COMPANY, state: { id: COMPANY, healthy: true } });
    expect(await op("sandbox.read", { id: COMPANY })).toEqual({
      id: COMPANY,
      gone: false,
      state: { id: COMPANY, healthy: true },
    });
    expect(await op("sandbox.plan", { id: COMPANY, desired: {} })).toMatchObject({ action: "none" });
    expect(await op("sandbox.read", { id: "another" })).toEqual({ id: "another", gone: true });
    expect(await op("sandbox.plan", { id: COMPANY })).toMatchObject({ action: "delete" });
    expect(await op("sandbox.delete", { id: COMPANY })).toEqual({ id: COMPANY, gone: true });
    expect(fake.state.boxes).toEqual({});
  });

  it("declares a sandbox type that names no image or size: the Cloud's", () => {
    expect(sandbox.sandbox).toMatchObject({ capabilities: { snapshot: true, pause: true, port: true }, inputs: {} });
    expect(sandbox({})).toBeTruthy();
  });
});
