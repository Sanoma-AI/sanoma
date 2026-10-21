import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { defineWorkflow } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useTestApp } from "../src/harness.ts";
import { testDatabaseUrl, withFake } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("testing_harness");
const blog = fakeGhost();

const draft = defineWorkflow({
  name: "draft",
  trigger: "manual",
  input: z.object({ title: z.string() }),
  uses: [ghost.post.create],
  run: async (ctx, { title }) => (await ctx.ghost.post.create({ title, html: "<p>x</p>", status: "draft" })).id,
});

const alice = { id: "alice" };

describe("useTestApp", () => {
  const app = useTestApp({ workflows: [draft], connectors: [withFake(ghost, blog)] }, { databaseUrl });

  it("keeps one config, so the client reads both runs across a restart", async () => {
    // On the database given, whatever the config says.
    expect(app.config.databaseUrl).toBe(databaseUrl);
    const first = await app.client.start(draft, { title: "Before" }, { startedBy: alice });
    await app.client.result(first);

    await app.stop();
    await app.restart();

    const second = await app.client.start(draft, { title: "After" }, { startedBy: alice });
    await app.client.result(second);
    for (const runId of [first, second]) {
      expect((await app.client.ledger(runId)).map((r) => r.type)).toEqual(["run.started", "op.called", "run.finished"]);
    }
    expect(Object.values(blog.state.posts).map((p) => p.title)).toEqual(["Before", "After"]);
  });
});
