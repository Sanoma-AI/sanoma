import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Outline, type OutlineNode, outlineWorkflow } from "../src/describe.ts";
import { defineConnector, defineWorkflow, type WorkflowDefinition } from "../src/index.ts";
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

/** The outline's nodes with their source, or a failure naming the error. */
function outlined(outline: Outline): { source: string; nodes: OutlineNode[] } {
  if ("error" in outline) throw new Error(outline.error);
  return outline;
}

/** The workflow as if `defineWorkflow` had been called from `file`. */
const withFile = (wf: WorkflowDefinition<any, any>, file: string | undefined): WorkflowDefinition<any, any> => ({
  ...wf,
  file,
});

/** Every node, nested ones included, in order. */
const flat = (nodes: OutlineNode[]): OutlineNode[] =>
  nodes.flatMap((node) => [
    node,
    ...flat(
      node.kind === "all" || node.kind === "branch"
        ? (node.kind === "all" ? node.branches : node.cases).flat()
        : node.kind === "each" || node.kind === "repeat"
          ? node.body
          : [],
    ),
  ]);

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
    expect(outlineWorkflow(fanout)).toMatchObject({
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
    expect(outlineWorkflow(announce)).toMatchObject({
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
    expect(outlineWorkflow(busy)).toMatchObject({
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
    expect(outlineWorkflow(branches)).toMatchObject({
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
    expect(outlineWorkflow(helpers)).toMatchObject({ nodes: [] });
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
    expect(outlineWorkflow(method)).toMatchObject({ nodes: [{ kind: "sleep" }, { kind: "approval", title: "Go?" }] });
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

const spans = defineWorkflow({
  name: "spans",
  trigger: "manual",
  input: z.object({ threads: z.array(z.string()), loud: z.boolean() }),
  uses: [forum.comments.list, bluesky.post.create, "all", "sleep"],
  run: async (ctx, { threads, loud }) => {
    await ctx.all([() => ctx.forum.comments.list({ thread: "a" })]);
    for (let i = 0; i < threads.length; i++) await ctx.sleep({ ms: i });
    threads.map((thread) => ctx.bluesky.post.create({ text: thread }));
    if (loud) await ctx.bluesky.post.create({ text: "loud" });
    else await ctx.sleep({ ms: 1 });
  },
});

describe("outlineWorkflow, spans", () => {
  it("reads the file that defined the workflow, and spans each node's code in it", () => {
    const { source, nodes } = outlined(outlineWorkflow(announce));
    expect(source).toBe(readFileSync(announce.file!, "utf8").replaceAll("\r\n", "\n"));
    expect(source.slice(...nodes[0]!.span)).toBe('ctx.ghost.post.create({ title, html: body, status: "draft" })');
    for (const node of nodes.filter((n) => n.kind === "op")) {
      expect(source.slice(...node.span)).toMatch(/^ctx\.[\s\S]*\)$/);
    }
  });

  it("spans ctx.all, a loop, a .map callback and an if/else as the whole construct", () => {
    const { source, nodes } = outlined(outlineWorkflow(spans));
    const text = nodes.map((node) => [node.kind, source.slice(...node.span)]);
    expect(text).toEqual([
      ["all", 'ctx.all([() => ctx.forum.comments.list({ thread: "a" })])'],
      ["repeat", "for (let i = 0; i < threads.length; i++) await ctx.sleep({ ms: i });"],
      ["repeat", "threads.map((thread) => ctx.bluesky.post.create({ text: thread }))"],
      ["branch", expect.stringMatching(/^if \(loud\) [\s\S]*else await ctx\.sleep\(\{ ms: 1 \}\);$/)],
    ]);
  });

  // What each kind's code starts with; `(ctx as any)[vendor]` is `ctx[vendor]` once types are stripped.
  const CALL = /^ctx[.[][\s\S]*\)$/;
  const CODE: Partial<Record<OutlineNode["kind"], RegExp>> = { repeat: /^(for \(|threads\.map\()/, branch: /^if \(/ };

  it("falls back to run's own text when the workflow has no file, with spans into that text", () => {
    for (const wf of [spans, busy, fanout]) {
      const { source, nodes } = outlined(outlineWorkflow(withFile(wf, undefined)));
      expect(source).toBe(Function.prototype.toString.call(wf.run));
      // The same nodes as read from the file, each spanning its code in the run text.
      expect(nodes.map((n) => n.kind)).toEqual(outlined(outlineWorkflow(wf)).nodes.map((n) => n.kind));
      for (const node of flat(nodes)) {
        expect(source.slice(...node.span)).toMatch(CODE[node.kind] ?? CALL);
      }
    }
  });

  it("falls back to run's text when the file cannot be read or does not hold the workflow", () => {
    const missing = outlined(outlineWorkflow(withFile(spans, join(tmpdir(), "sanoma-no-such-file.ts"))));
    expect(missing.source).toBe(Function.prototype.toString.call(spans.run));
    const elsewhere = outlined(
      outlineWorkflow(withFile(spans, fileURLToPath(new URL("./fixtures/fanout.ts", import.meta.url)))),
    );
    expect(elsewhere.source).toBe(Function.prototype.toString.call(spans.run));
  });

  it("reads a file with \\r\\n line endings as if it had \\n", () => {
    const text = `import { defineWorkflow } from "@sanoma/workflows";

export default defineWorkflow({
  name: "spans",
  run: async (ctx) => {
    await ctx.sleep({ ms: 1 });
    if (ctx.runId) {
      await ctx.forum.comments.list({ thread: "a" });
    }
  },
});
`;
    const dir = mkdtempSync(join(tmpdir(), "sanoma-outline-"));
    try {
      const lf = join(dir, "lf.ts");
      const crlf = join(dir, "crlf.ts");
      writeFileSync(lf, text);
      writeFileSync(crlf, text.replaceAll("\n", "\r\n"));
      const fromLf = outlined(outlineWorkflow(withFile(spans, lf)));
      const fromCrlf = outlined(outlineWorkflow(withFile(spans, crlf)));
      expect(fromLf.source).toBe(text);
      expect(fromCrlf).toEqual(fromLf);
      expect(fromCrlf.nodes.map((node) => text.slice(...node.span))).toEqual([
        "ctx.sleep({ ms: 1 })",
        expect.stringMatching(/^if \(ctx\.runId\) \{[\s\S]*\}$/),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      // The package's build is this one tsc run.
      const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
      const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkg, encoding: "utf8" });
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
      const outline = JSON.parse(out.stdout);
      expect(outline).toMatchObject({
        nodes: [
          { kind: "each", body: [{ kind: "op", id: "forum.comments.list" }] },
          { kind: "branch", cases: [[{ kind: "sleep" }], []] },
        ],
      });
      // defineWorkflow was called from the script, so the outline reads the script.
      const { source, nodes } = outlined(outline);
      expect(source).toBe(readFileSync(script, "utf8"));
      expect(source.slice(...nodes[0]!.span)).toMatch(/^ctx\.all\(ids\.map\([\s\S]*\)$/);
      expect(source.slice(...nodes[1]!.span)).toBe("if (ids.length > 1) await ctx.sleep({ seconds: 1 });");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
