import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outlineWorkflow } from "../src/describe.ts";
import { defineConnector, defineWorkflow } from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import fanout from "./fixtures/fanout.ts";

const forum = defineConnector("forum", {
  comments: {
    list: { effect: "read", input: z.object({ thread: z.string() }), output: z.array(z.string()) },
  },
});

/** Defined outside `run`, so the outline cannot see the call it makes. */
const tally = async (
  ctx: { forum: { comments: { list(i: { thread: string }): Promise<string[]> } } },
  thread: string,
) => ctx.forum.comments.list({ thread });

const busy = defineWorkflow({
  name: "busy",
  trigger: "manual",
  input: z.object({ threads: z.array(z.string()), vendor: z.string(), loud: z.boolean() }),
  uses: [forum.comments.list, bluesky.post.create, "all", "approval", "sleep"],
  run: async (ctx, { threads, vendor, loud }) => {
    const [first] = await ctx.all([
      () => ctx.forum.comments.list({ thread: "a" }),
      async () => {
        await ctx.sleep({ minutes: 1 });
        return ctx.forum.comments.list({ thread: "b" });
      },
    ]);
    const counts = await ctx.all(threads.map((thread) => () => ctx.forum.comments.list({ thread })));
    if (loud) await ctx.approval("Shout?", { approver: "lead" });
    else if (first.length) await ctx.bluesky.post.create({ text: "quiet" });
    else console.log("nothing to say");
    for (const thread of threads) {
      await ctx.bluesky.post.create({ text: thread });
    }
    const replies = threads.map((thread) => thread.length);
    await (ctx as any)[vendor].comments.list({ thread: "x" });
    await tally(ctx, "y");
    return [counts, replies];
  },
});

describe("outlineWorkflow", () => {
  it("outlines the fan-out fixture: two ctx.all around a sleep", () => {
    expect(outlineWorkflow(fanout)).toEqual({
      nodes: [
        {
          kind: "all",
          branches: [
            [{ kind: "op", id: "ghost.post.create" }],
            [{ kind: "op", id: "resend.broadcast.create" }],
            [{ kind: "op", id: "bluesky.post.create" }],
          ],
        },
        { kind: "sleep" },
        {
          kind: "all",
          branches: [[{ kind: "op", id: "stats.post.views" }], [{ kind: "op", id: "stats.email.opens" }]],
        },
      ],
    });
  });

  it("outlines the announce workflow: its calls in order", () => {
    expect(outlineWorkflow(announce)).toEqual({
      nodes: [
        { kind: "op", id: "ghost.post.create" },
        { kind: "op", id: "resend.broadcast.create" },
        { kind: "approval", title: "Review launch copy" },
        { kind: "sleep" },
        { kind: "op", id: "ghost.post.publish" },
        { kind: "op", id: "resend.broadcast.send" },
        { kind: "op", id: "bluesky.post.create" },
      ],
    });
  });

  it("nests fan-outs, branches and loops, stars computed segments, and cannot see into helpers", () => {
    expect(outlineWorkflow(busy)).toEqual({
      nodes: [
        {
          kind: "all",
          branches: [
            [{ kind: "op", id: "forum.comments.list" }],
            [{ kind: "sleep" }, { kind: "op", id: "forum.comments.list" }],
          ],
        },
        { kind: "each", body: [{ kind: "op", id: "forum.comments.list" }] },
        {
          kind: "branch",
          // The final else logs and makes no call: the empty case.
          cases: [[{ kind: "approval", title: "Shout?" }], [{ kind: "op", id: "bluesky.post.create" }], []],
        },
        { kind: "repeat", body: [{ kind: "op", id: "bluesky.post.create" }] },
        { kind: "op", id: "*.comments.list" },
      ],
    });
  });

  it("keeps the way past a branch's calls: a missing else or default, an arm without calls, && and ??", () => {
    const post = { kind: "op", id: "bluesky.post.create" } as const;
    const bypassed = { kind: "branch", cases: [[post], []] } as const;
    const branches = defineWorkflow({
      name: "branches",
      trigger: "manual",
      input: z.object({ loud: z.boolean(), mood: z.string(), text: z.string().optional() }),
      uses: [bluesky.post.create, "sleep"],
      run: async (ctx, { loud, mood, text }) => {
        if (loud) await ctx.bluesky.post.create({ text: "if" });
        switch (mood) {
          case "glad":
          case "happy":
            await ctx.bluesky.post.create({ text: "case" });
            break;
        }
        await (loud ? ctx.bluesky.post.create({ text: "?:" }) : undefined);
        await (loud && ctx.bluesky.post.create({ text: "&&" }));
        await (text ?? ctx.bluesky.post.create({ text: "??" }));
        // Both arms call: no way past.
        await (loud ? ctx.bluesky.post.create({ text: "a" }) : ctx.sleep({ ms: 1 }));
      },
    });
    expect(outlineWorkflow(branches)).toEqual({
      nodes: [
        bypassed,
        bypassed,
        bypassed,
        bypassed,
        bypassed,
        { kind: "branch", cases: [[post], [{ kind: "sleep" }]] },
      ],
    });
  });

  it("does not read a function defined inside run: its calls run where it is called", () => {
    const helpers = defineWorkflow({
      name: "helpers",
      trigger: "manual",
      input: z.object({ threads: z.array(z.string()) }),
      uses: [forum.comments.list, bluesky.post.create],
      run: async (ctx, { threads }) => {
        const list = async (thread: string) => ctx.forum.comments.list({ thread });
        async function post(text: string) {
          await ctx.bluesky.post.create({ text });
        }
        for (const thread of threads) await post(String(await list(thread)));
        return threads;
      },
    });
    expect(outlineWorkflow(helpers)).toEqual({ nodes: [] });
  });

  it("reads a run written as a method, and whatever its ctx parameter is named", () => {
    const method = defineWorkflow({
      name: "method",
      trigger: "manual",
      input: z.object({}),
      uses: ["sleep", "approval"],
      async run(c) {
        await c.sleep({ ms: 1 });
        await c.approval(`Go?`, { approver: "lead" });
      },
    });
    expect(outlineWorkflow(method)).toEqual({ nodes: [{ kind: "sleep" }, { kind: "approval", title: "Go?" }] });
  });

  it("says why when run destructures ctx, or its source cannot be parsed", () => {
    const destructured = defineWorkflow({
      name: "destructured",
      trigger: "manual",
      input: z.object({}),
      uses: [bluesky.post.create],
      run: async ({ bluesky: b }) => b.post.create({ text: "x" }),
    });
    expect(outlineWorkflow(destructured)).toEqual({ error: expect.stringMatching(/takes no ctx parameter by name/) });

    // A native function's source is `function max() { [native code] }`.
    const native = defineWorkflow({
      name: "native",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: Math.max as never,
    });
    expect(outlineWorkflow(native)).toEqual({ error: expect.stringMatching(/^Cannot parse native's run: /) });
  });
});

// The built package reads `run` as JavaScript. Builds dist/ when it is missing or older than src/.
describe("outlineWorkflow, built", () => {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  const dist = (file: string) => pathToFileURL(join(pkg, "dist", file)).href;

  function needsBuild(): boolean {
    const built = join(pkg, "dist", "describe.js");
    if (!existsSync(built)) return true;
    const builtAt = statSync(built).mtimeMs;
    return readdirSync(join(pkg, "src")).some((file) => statSync(join(pkg, "src", file)).mtimeMs > builtAt);
  }

  it("outlines a workflow from its JavaScript source, in plain Node", () => {
    if (needsBuild()) {
      const build = spawnSync("pnpm", ["run", "build"], { cwd: pkg, encoding: "utf8" });
      if (build.status !== 0) throw new Error(`build failed: ${build.stderr}${build.stdout}`);
    }
    const dir = mkdtempSync(join(tmpdir(), "sanoma-outline-"));
    try {
      const script = join(dir, "outline.mjs");
      writeFileSync(
        script,
        `import { defineWorkflow } from ${JSON.stringify(dist("index.js"))};
import { outlineWorkflow } from ${JSON.stringify(dist("describe.js"))};
const built = defineWorkflow({
  name: "built",
  trigger: "manual",
  input: null,
  uses: ["all", "sleep"],
  run: async (ctx, { ids }) => {
    await ctx.all(ids.map((id) => () => ctx.forum.comments.list({ thread: id })));
    if (ids.length > 1) await ctx.sleep({ seconds: 1 });
    return ids;
  },
});
console.log(JSON.stringify(outlineWorkflow(built)));
`,
      );
      const out = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(out.status, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        nodes: [
          { kind: "each", body: [{ kind: "op", id: "forum.comments.list" }] },
          { kind: "branch", cases: [[{ kind: "sleep" }], []] },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
