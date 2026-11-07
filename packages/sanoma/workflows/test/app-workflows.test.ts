import { testDatabaseUrl } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AppStepContext,
  type AppSteps,
  APPLY_WORKFLOW,
  defineWorkflow,
  errorCode,
  memoryLedger,
  resolveConfig,
  SanomaError,
  type Source,
} from "../src/index.ts";
import { NO_APP_STEPS } from "../src/app-steps.ts";
import { describeConfig } from "../src/describe.ts";
import {
  ADOPT_WORKFLOW,
  BUILT_IN_WORKFLOWS,
  CONNECT_EXISTING_WORKFLOW,
  GO_LIVE_HOST_WORKFLOW,
  GO_LIVE_WORKFLOW,
  PATCH_WORKFLOW,
  visitorPrincipal,
} from "../src/shared.ts";
import { companyFakes } from "./fixtures/company/fakes.ts";
import { ALICE, failure, rootWith } from "./harness.ts";

// The app's own actions on the repository as built-in workflows (`app-workflows.ts`): registered
// in every config, never a visitor's to start, run by a worker with the app's steps (each in a
// step of its own, given the worker's client, source, config, the run's actor and id; one at a
// time; an apply after its write started as the run's child), and failing, saying so, on a
// worker without them.

/** Each of the app's built-ins, with an input it takes. */
const INPUTS = {
  [ADOPT_WORKFLOW]: { runId: "drift-1", id: "resources/a.ts#a", paths: ["name"] },
  [PATCH_WORKFLOW]: { at: { file: "resources/people.ts", export: "alice" }, fields: { name: "Alice" } },
  [GO_LIVE_WORKFLOW]: { owner: "acme", name: "acme-ops", region: "eu-west-1", port: 8080 },
  [GO_LIVE_HOST_WORKFLOW]: {},
  [CONNECT_EXISTING_WORKFLOW]: { repository: "acme/ops" },
};
const APP_WORKFLOWS = Object.keys(INPUTS) as (keyof typeof INPUTS)[];

const root = rootWith({ "resources/people.ts": ALICE });
/** A company with resource types, so apply is registered, and nothing declared. */
const config = () => ({ workflows: [], connectors: companyFakes().connectors, root, ledger: memoryLedger() });

describe("the app's built-in workflows", () => {
  it("are in every config, built in, and no workflow of the config's may take their names", () => {
    const resolved = resolveConfig({ workflows: [], connectors: [], root });
    for (const name of APP_WORKFLOWS) {
      expect(BUILT_IN_WORKFLOWS.has(name)).toBe(true);
      expect(resolved.workflows.get(name)?.name).toBe(name);
    }
    const described = describeConfig({ workflows: [], connectors: [], root }).workflows;
    expect(described.filter((wf) => wf.builtin).map((wf) => wf.name)).toEqual(expect.arrayContaining(APP_WORKFLOWS));
    const named = defineWorkflow({
      name: "adopt",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => 1,
    });
    expect(() => resolveConfig({ workflows: [named], connectors: [], root })).toThrow(
      'A workflow is named "adopt", the name of a built-in workflow; name it otherwise',
    );
  });
});

describe("on a worker given the app's steps", () => {
  /** What each step was given, by the run it ran in. */
  const given: Record<string, Omit<AppStepContext, "client"> & { client: boolean }> = {};
  /** How many steps write at once, at most: each under the worker's lock, as the app's do. */
  let running = 0;
  let most = 0;
  const source: Source = { root, head: () => "0000000000000000", commit: () => ({ revision: "0000000000000000" }) };
  const record = async (step: AppStepContext) => {
    const { client, ...rest } = step;
    given[step.runId] = { ...rest, client: client !== undefined };
    await step.serially(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((done) => setTimeout(done, 50));
      running -= 1;
    });
  };
  const steps: AppSteps = {
    adopt: async (step, input) => {
      await record(step);
      return { file: input.id.split("#")[0]! };
    },
    patch: async (step) => {
      await record(step);
      throw new SanomaError("not_approver", "A change to the rules waits for an admin", {
        approver: { group: "admin" },
      });
    },
    goLive: async (step) => {
      await record(step);
      return { apply: { only: [] } };
    },
    goLiveHost: async (step) => {
      await record(step);
      throw new Error("Apply the repository, its deploy key and the database first");
    },
    connectExisting: async (step) => {
      await record(step);
      return { file: "resources/sanoma/infra.ts", text: "export default [];\n", apply: { only: [] } };
    },
    chat: async () => {
      throw new Error("No chat turns here");
    },
  };
  const app = useTestApp(config(), { databaseUrl: testDatabaseUrl("app_workflows"), source, app: steps });

  it("runs each in a step given the worker's client, repository, lock and config, and the run's actor and id, its writes one at a time", async () => {
    const inputs = [
      { runId: "drift-1", id: "resources/a.ts#a", paths: ["name"] },
      { runId: "drift-1", id: "resources/b.ts#b", paths: ["name"] },
    ];
    const runIds = await Promise.all(
      inputs.map((input) => app.client.start(ADOPT_WORKFLOW, input, { startedBy: "alice" })),
    );
    expect(await Promise.all(runIds.map((runId) => app.client.result(runId)))).toEqual([
      { file: "resources/a.ts" },
      { file: "resources/b.ts" },
    ]);
    expect(most).toBe(1);
    const step = given[runIds[0]!]!;
    expect(step).toMatchObject({ client: true, source, by: { id: "alice" }, runId: runIds[0] });
    expect(step.resolved.root).toBe(root);
    expect(step.config.root).toBe(root);
  });

  it("refuses an input that does not match at the start, before any step", async () => {
    const err = await failure(
      app.client.start(ADOPT_WORKFLOW, { runId: "", id: "x", paths: [] }, { startedBy: "alice" }),
    );
    expect(errorCode(err)).toBe("invalid_input");
  });

  it("fails the run with the step's error, its code and data kept for the page", async () => {
    const patched = await app.client.start(PATCH_WORKFLOW, INPUTS[PATCH_WORKFLOW], { startedBy: "alice" });
    const err = await failure(app.client.result(patched));
    expect(err).toMatchObject({
      code: "not_approver",
      message: "A change to the rules waits for an admin",
      data: { approver: { group: "admin" } },
    });
    const pushed = await app.client.start(GO_LIVE_HOST_WORKFLOW, {}, { startedBy: "alice" });
    await expect(app.client.result(pushed)).rejects.toThrow(
      "Apply the repository, its deploy key and the database first",
    );
    expect((await app.client.run(pushed))?.error).toBe("Apply the repository, its deploy key and the database first");
  });

  it("starts the apply after a write as the run's child, as its actor, and answers its id without waiting for it", async () => {
    const live = await app.client.start(GO_LIVE_WORKFLOW, INPUTS[GO_LIVE_WORKFLOW], { startedBy: "alice" });
    expect(await app.client.result(live)).toEqual({ runId: `${live}:apply` });
    const connected = await app.client.start(CONNECT_EXISTING_WORKFLOW, INPUTS[CONNECT_EXISTING_WORKFLOW], {
      startedBy: "alice",
    });
    expect(await app.client.result(connected)).toEqual({
      file: "resources/sanoma/infra.ts",
      text: "export default [];\n",
      runId: `${connected}:apply`,
    });
    for (const runId of [`${live}:apply`, `${connected}:apply`]) {
      await app.client.result(runId);
      expect(await app.client.run(runId)).toMatchObject({ workflow: APPLY_WORKFLOW, startedBy: { id: "alice" } });
    }
  });

  it("is no visitor's to start, nor an api token's, whatever its groups: staff's, as the app's own host admits them", async () => {
    const { id } = await app.client.tokens.mint({ subject: "visitor:better-auth:u1", groups: ["admin"] });
    for (const startedBy of [visitorPrincipal("auth0", "u1"), { id: `token:${id}`, groups: ["admin"] }]) {
      for (const name of APP_WORKFLOWS) {
        const err = await failure(app.client.start(name, INPUTS[name], { startedBy }));
        expect(errorCode(err), `${startedBy.id} ${name}`).toBe("policy_denied");
      }
    }
  });
});

describe("on a worker without the app's steps", () => {
  const app = useTestApp(config(), { databaseUrl: testDatabaseUrl("app_workflows_none") });

  it("fails each run, saying the worker runs none of the app's actions", async () => {
    const runId = await app.client.start(ADOPT_WORKFLOW, INPUTS[ADOPT_WORKFLOW], { startedBy: "alice" });
    await expect(app.client.result(runId)).rejects.toThrow(NO_APP_STEPS);
  });
});
