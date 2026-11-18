import { checkSandbox } from "sanoma/testing/sandbox";
import { type CallContext, memorySecrets, RUNNER_PROTOCOL } from "sanoma/workflows";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cloudBackend } from "../src/backend.ts";
import { sandbox } from "../src/connector.ts";
import { BOX_LIMITS, BOXES_BUSY, fakeCloud } from "../src/fake.ts";
import type { CloudApi } from "../src/operations.ts";

// `cloud.sandbox`'s backend over the fake Cloud's boxes, which run Sanoma's runner on this machine:
// the Sandbox contract's conformance kit, the boxes named by the company, the company's limits and
// the account's, a runner of another protocol refused, and the declaration bound to the company.

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

/** A Cloud whose `cloud-box-open` answers a runner of `protocol`. */
const answering = (protocol: number) =>
  ({
    boxOpen: async () => ({ id: "i1", url: "https://i1-7700.agent37.app/?a37_token=t", expiresAt: "", protocol }),
  }) as unknown as CloudApi;

describe("cloud.sandbox's backend on the fake Cloud", () => {
  it("passes the sandbox conformance kit", async () => {
    const results = await checkSandbox({
      backend: fake.sandbox(),
      capabilities: sandbox.sandbox!.capabilities,
      timeoutMs: 20_000,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(9);
  });

  it("names a box by the company, opens it to its hosts, and puts it to sleep on stop", async () => {
    const box = await fake.sandbox().open({ name: "sanoma-acme-ada", hosts: HOSTS });
    expect(fake.state.boxes).toEqual({ [`${COMPANY}/sanoma-acme-ada`]: { id: box.id, awake: true, hosts: HOSTS } });
    const ran = await box.run("echo hi");
    expect(await new Response(ran.stdout).text()).toBe("hi\n");
    expect((await box.expose(4321)).url).toMatch(/^http:\/\/127\.0\.0\.1:4321\/\?a37_token=fake-\d+$/);
    await box.stop();
    expect(fake.state.boxes[`${COMPANY}/sanoma-acme-ada`]?.awake).toBe(false);
  });

  it("keeps a company to its boxes and its awake ones, and says when the Cloud's are all busy", async () => {
    const backend = fake.sandbox();
    const opened = [];
    for (let i = 0; i < BOX_LIMITS.awake; i++) opened.push(await backend.open({ name: `box-${i}`, hosts: HOSTS }));
    await expect(backend.open({ name: "box-2", hosts: HOSTS })).rejects.toThrow(
      `${BOX_LIMITS.awake} of this company's agent boxes are in use already`,
    );
    // An awake box opens again.
    await backend.open({ name: "box-0", hosts: HOSTS });
    for (const box of opened) await box.stop();
    for (let i = BOX_LIMITS.awake; i < BOX_LIMITS.boxes; i++) {
      await (await backend.open({ name: `box-${i}`, hosts: HOSTS })).stop();
    }
    await expect(backend.open({ name: "one-more", hosts: HOSTS })).rejects.toThrow(
      `This company has ${BOX_LIMITS.boxes} agent boxes already`,
    );
    await backend.discard({ name: "box-0" });
    await (await backend.open({ name: "one-more", hosts: HOSTS })).stop();

    const busy = fakeCloud({ slug: "acme", awakeBoxes: 1 });
    try {
      await busy.sandbox().open({ name: "first", hosts: HOSTS });
      await expect(busy.sandbox().open({ name: "second", hosts: HOSTS })).rejects.toThrow(BOXES_BUSY);
    } finally {
      await busy.close();
    }
  });

  it("refuses a link to a box there is not, and discards one there is not as done", async () => {
    const backend = fake.sandbox();
    await backend.discard({ name: "never" });
    const box = await backend.open({ name: "a", hosts: HOSTS });
    await backend.discard({ name: "a" });
    expect(fake.state.boxes).toEqual({});
    await expect(box.expose(3000)).rejects.toThrow("Sanoma Cloud: cloud-box-expose: There is no agent box a");
  });

  it("refuses a runner of another protocol than this release's, saying which side to update", async () => {
    await expect(cloudBackend(answering(RUNNER_PROTOCOL + 1)).open({ name: "a", hosts: HOSTS })).rejects.toThrow(
      "update the company's sanoma package",
    );
    await expect(cloudBackend(answering(RUNNER_PROTOCOL - 1)).open({ name: "a", hosts: HOSTS })).rejects.toThrow(
      "Sanoma Cloud has not moved to this release yet",
    );
  });

  it("discards the company's boxes when it closes", async () => {
    await op("database.create", { desired: { region: "us-east" } });
    await (await fake.sandbox().open({ name: "a", hosts: HOSTS })).stop();
    await op("database.delete", { id: COMPANY });
    expect(fake.state.boxes).toEqual({});
    expect(fake.state.revoked).toBe(true);
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
