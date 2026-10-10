import { bluesky } from "@sanoma/connector-bluesky";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outlineWorkflow } from "../src/describe.ts";
import {
  allowAll,
  type Ctx,
  defineWorkflow,
  errorCode,
  type LedgerRecord,
  memoryLedger,
  startWorker,
} from "../src/index.ts";
import { failure, useApp } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("callsite");
const alice = { id: "alice" };

type Posting = Ctx<readonly [typeof bluesky.post.create]>;

/** A helper the workflow passes ctx to: its call is not in the outline, so the worker refuses it. */
const post = (ctx: Posting, text: string) => ctx.bluesky.post.create({ text });

/** One post per text, in a loop: one node, called as often as there are texts. */
const loop = defineWorkflow({
  name: "loop",
  trigger: "manual",
  input: z.object({ texts: z.array(z.string()) }),
  uses: [bluesky.post.create, "sleep"],
  run: async (ctx, { texts }) => {
    for (const text of texts) await ctx.bluesky.post.create({ text });
    await ctx.sleep({ ms: 1 });
    return texts.length;
  },
});

const helper = defineWorkflow({
  name: "helper",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
  run: async (ctx, { text }) => post(ctx, text),
});

/** Reaches ctx without naming it, which the outline cannot see: the run's own check catches the call. */
const sneaky = defineWorkflow({
  name: "sneaky",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create],
  async run(ctx, { text }) {
    const c = arguments[0] as typeof ctx;
    return c.bluesky.post.create({ text });
  },
});

const fan = defineWorkflow({
  name: "fan",
  trigger: "manual",
  input: z.object({ texts: z.array(z.string()).length(2) }),
  uses: [bluesky.post.create, "all"],
  run: async (ctx, { texts }) => {
    const [a, b] = await ctx.all([
      () => ctx.bluesky.post.create({ text: texts[0]! }),
      () => ctx.bluesky.post.create({ text: texts[1]! }),
    ]);
    const rest = await ctx.all(texts.map((text) => () => ctx.bluesky.post.create({ text: `${text}!` })));
    return [a.uri, b.uri, rest.length];
  },
});

const tried = defineWorkflow({
  name: "tried",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [bluesky.post.create, "sleep"],
  run: async (ctx, { text }) => {
    try {
      await ctx.bluesky.post.create({ text });
    } catch {
      await ctx.sleep({ ms: 1 });
    }
    return "done";
  },
});

const nodes = (records: LedgerRecord[]) =>
  records.flatMap((r) =>
    r.type === "op.called" || r.type === "sleep.started" || r.type === "approval.requested"
      ? [
          `${r.type === "op.called" ? r.op : r.type} @${r.node}${r.group ? ` in ${r.group.node}[${r.group.index}]` : ""}`,
        ]
      : [],
  );

describe("where a ctx call is made", () => {
  const app = useApp(databaseUrl, "callsite", () => ({ workflows: [loop, fan, tried, sneaky] }));
  const c = () => app.client;

  it("records each call's outline node, the same node for every pass of a loop", async () => {
    const runId = await c().start(loop, { texts: ["a", "b"] }, { startedBy: alice });
    expect(await c().result(runId)).toBe(2);
    expect(nodes(await c().ledger(runId))).toEqual([
      "bluesky.post.create @0.0.0",
      "bluesky.post.create @0.0.0",
      "sleep.started @1",
    ]);
    const outline = outlineWorkflow(loop);
    expect(outline).toMatchObject({
      nodes: [
        { kind: "repeat", path: "0", body: [{ kind: "op", path: "0.0.0" }] },
        { kind: "sleep", path: "1" },
      ],
    });
  });

  it("records a ctx.all's members with the group's node, and the member's call its own", async () => {
    const runId = await c().start(fan, { texts: ["a", "b"] }, { startedBy: alice });
    expect(await c().result(runId)).toEqual([expect.any(String), expect.any(String), 2]);
    expect(nodes(await c().ledger(runId))).toEqual([
      "bluesky.post.create @0.0.0 in 0[0]",
      "bluesky.post.create @0.1.0 in 0[1]",
      "bluesky.post.create @1.0.0 in 1[0]",
      "bluesky.post.create @1.0.0 in 1[1]",
    ]);
  });

  it("records a call in a try block at its node", async () => {
    const runId = await c().start(tried, { text: "a" }, { startedBy: alice });
    expect(await c().result(runId)).toBe("done");
    expect(nodes(await c().ledger(runId))).toEqual(["bluesky.post.create @0.0.0"]);
  });

  it("refuses a call the outline could not see coming, failing the run with call_not_in_outline", async () => {
    const runId = await c().start(sneaky, { text: "x" }, { startedBy: alice });
    const err = await failure(c().result(runId));
    expect(errorCode(err)).toBe("call_not_in_outline");
    expect((err as Error).message).toMatch(
      /^ctx\.bluesky\.post\.create was called from .*callsite\.test\.ts:\d+:\d+, which is no ctx call in sneaky's outline: call ctx directly in run, .*\(inline it\), so the run's graph shows the call$/,
    );
    // Nothing was called: the refusal comes before the policy and the driver.
    expect(app.ops()).toEqual([]);
    const records = await c().ledger(runId);
    expect(records.map((r) => r.type)).toEqual(["run.started", "run.failed"]);
    expect(records[1]).toMatchObject({ error: { code: "call_not_in_outline", data: { workflow: "sneaky" } } });
  });
});

describe("a workflow the outline cannot draw", () => {
  // What the outline refuses is covered in outline.test.ts and lint.test.ts; here, that the worker does not start.
  it("does not start: the worker refuses a workflow that passes ctx to a helper, naming the line", async () => {
    const config = {
      workflows: [helper],
      connectors: [bluesky],
      drivers: [fakeBluesky().driver],
      policy: allowAll,
      ledger: memoryLedger(),
      databaseUrl: "postgresql://unused@localhost:1/unused",
      appName: "callsite-refused",
    };
    await expect(startWorker(config)).rejects.toThrow(
      /^Workflow "helper" cannot be outlined, so its runs could not be held to its code: .*\/callsite\.test\.ts:\d+:\d+: ctx is only called, directly/,
    );
  });
});
