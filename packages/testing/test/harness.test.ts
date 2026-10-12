import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { allowAll, defineWorkflow } from "@sanoma/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useTestApp } from "../src/harness.ts";
import { testDatabaseUrl } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`.
const appName = "testing_harness";
const blog = fakeGhost();

const draft = defineWorkflow({
  name: "draft",
  trigger: "manual",
  input: z.object({ title: z.string() }),
  uses: [ghost.post.create],
  run: async (ctx, { title }) => (await ctx.ghost.post.create({ title, html: "<p>x</p>", status: "draft" })).id,
});
const held = defineWorkflow({
  name: "held",
  trigger: "manual",
  input: z.object({}),
  uses: ["approval"],
  run: async (ctx) => ctx.approval("Never decided", { approver: "nobody" }),
});

const alice = { id: "alice" };
let leftId: string | undefined;

describe("useTestApp", () => {
  const app = useTestApp({
    workflows: [draft, held],
    connectors: [ghost],
    drivers: [blog.driver],
    policy: allowAll,
    appName,
  });

  it("resolves the ledger and the database once", () => {
    expect(app.config).toMatchObject({ appName, databaseUrl: testDatabaseUrl(appName) });
    expect(typeof app.config.ledger.append).toBe("function");
  });

  it("restarts the worker on the same ledger", async () => {
    const first = await app.client.start(draft, { title: "Before" }, { startedBy: alice });
    await app.client.result(first);

    await app.stop();
    expect(() => app.worker).toThrow("worker is not started");
    await app.restart();

    const second = await app.client.start(draft, { title: "After" }, { startedBy: alice });
    await app.client.result(second);
    for (const runId of [first, second]) {
      expect((await app.client.ledger(runId)).map((r) => r.type)).toEqual(["run.started", "op.called", "run.finished"]);
    }
    expect(Object.values(blog.state.posts).map((p) => p.title)).toEqual(["Before", "After"]);
  });

  it("leaves a run unfinished for afterAll to cancel", async () => {
    leftId = await app.client.start(held, {}, { startedBy: alice });
    app.leftPending.push(leftId);
    expect((await app.raw.getWorkflow(leftId))?.status).not.toBe("CANCELLED");
  });
});

describe("after useTestApp's tests", () => {
  it("has cancelled leftPending", async () => {
    const raw = await DBOSClient.create({ systemDatabaseUrl: testDatabaseUrl(appName), applicationName: appName });
    try {
      expect((await raw.getWorkflow(leftId!))?.status).toBe("CANCELLED");
    } finally {
      await raw.destroy();
    }
  });
});
