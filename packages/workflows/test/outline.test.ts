import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bluesky } from "@sanoma/connector-bluesky";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { offsetOf } from "../src/ast.ts";
import { type OutlineNode, outlineWorkflow } from "../src/describe.ts";
import { defineConnector, defineWorkflow, type WorkflowDefinition } from "../src/index.ts";
import { callAt, callsOf, flatten, outlineWithSource } from "../src/outline.ts";
import announce from "./fixtures/announce.ts";
import { ensureBuilt, pkg } from "./build.ts";
import fanout from "./fixtures/fanout.ts";

const forum = defineConnector("forum", {
  comments: {
    list: { effect: "read", input: z.object({ thread: z.string() }), output: z.array(z.string()) },
  },
});

/**
 * The workflow's outline with the text its spans index into, or a failure naming the error.
 * Takes a copy with another `file` (`{ ...wf, file }`) as the definition it stands for.
 */
function outlined(wf: Omit<WorkflowDefinition, "run"> & { run: (...args: never[]) => unknown }): {
  nodes: OutlineNode[];
  source: string;
  file: string;
} {
  const { outline, source } = outlineWithSource(wf as WorkflowDefinition<any, any>);
  if ("error" in outline) throw new Error(outline.error);
  return { ...outline, source: source! };
}

/** Why the workflow cannot be outlined. */
const unread = (wf: Omit<WorkflowDefinition, "run"> & { run: (...args: never[]) => unknown }): string => {
  const outline = outlineWorkflow(wf as WorkflowDefinition<any, any>);
  if (!("error" in outline)) throw new Error(`outlined: ${JSON.stringify(outline)}`);
  return outline.error;
};

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
    for (let i = 0; i < threads.length; i++) await ctx.sleep({ ms: i });
    threads.map((thread) => ctx.bluesky.post.create({ text: thread }));
    const replies = threads.map((thread) => thread.length);
    await (ctx as any)[vendor].comments.list({ thread: "x" });
    return [counts, replies];
  },
});

/** Takes ctx, which the outline refuses: a helper's calls would not be in the graph. */
const tally = (c: unknown) => c;

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

  it("nests fan-outs, branches and loops, and stars computed segments", () => {
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
        { kind: "repeat", body: [{ kind: "sleep" }] },
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

  it("refuses a function defined inside run that uses ctx, and ctx passed on: the graph could not show their calls", () => {
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
        return [threads, tally(ctx)];
      },
    });
    // One line per problem, at file:line:column.
    expect(unread(helpers).split("\n")).toEqual([
      expect.stringMatching(
        /^\/.*outline\.test\.ts:\d+:\d+: a function defined in run uses ctx, and the outline does not read it: inline/,
      ),
      expect.stringMatching(/^\/.*outline\.test\.ts:\d+:\d+: a function defined in run uses ctx/),
      expect.stringMatching(/^\/.*outline\.test\.ts:\d+:\d+: ctx is only called, directly/),
    ]);
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

  it("says why when run destructures ctx, or is no function written in the file", () => {
    const destructured = defineWorkflow({
      name: "destructured",
      trigger: "manual",
      input: z.object({}),
      uses: [bluesky.post.create],
      run: async ({ bluesky: b }) => b.post.create({ text: "x" }),
    });
    expect(unread(destructured)).toMatch(/takes no ctx parameter by name/);

    // The file holds the literal, but its `run` is no function to read.
    const native = defineWorkflow({
      name: "native",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: Math.max as never,
    });
    expect(unread(native)).toBe(`${native.file} holds no workflow named "native"`);
  });

  it("outlines a try as its body and its handler", () => {
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
        } finally {
          console.log("done");
        }
        try {
          console.log("no calls");
        } catch {
          console.log("none here either");
        }
      },
    });
    const { nodes, source } = outlined(tried);
    expect(nodes).toMatchObject([
      { kind: "try", path: "0", body: [{ kind: "op", path: "0.0.0" }], handler: [{ kind: "sleep", path: "0.1.0" }] },
    ]);
    expect(source.slice(...nodes[0]!.span)).toMatch(/^try \{[\s\S]*finally \{[\s\S]*\}$/);
  });

  it("gives each node its path: its index among its siblings, under its parent's and the list it is in", () => {
    expect(outlineWorkflow(announce)).toMatchObject({
      nodes: ["0", "1", "2", "3", "4", "5", "6"].map((path) => ({ path })),
    });
    const { nodes } = outlined(busy);
    expect(flatten(nodes).map((node) => `${node.path} ${node.kind}`)).toEqual([
      "0 all",
      "0.0.0 op",
      "0.1.0 sleep",
      "0.1.1 op",
      "1 each",
      "1.0.0 op",
      "2 branch",
      "2.0.0 approval",
      "2.1.0 op",
      "3 repeat",
      "3.0.0 op",
      "4 repeat",
      "4.0.0 sleep",
      "5 repeat",
      "5.0.0 op",
      "6 op",
    ]);
  });
});

describe("callAt", () => {
  it("finds the call whose code holds a position, the innermost: where a stack frame places a call, at its callee", () => {
    const { nodes: outline, source } = outlined(busy);
    const nodes = callsOf(outline);
    // `ctx.all([` is the all node; a member's call inside it is the member's.
    const all = source.indexOf("ctx.all([");
    expect(callAt(nodes, all)).toMatchObject({ kind: "all", path: "0" });
    expect(callAt(nodes, all + "ctx.".length)).toMatchObject({ kind: "all", path: "0" });
    expect(callAt(nodes, source.indexOf('comments.list({ thread: "a" })') + "comments.".length)).toMatchObject({
      kind: "op",
      path: "0.0.0",
    });
    expect(callAt(nodes, source.indexOf("ctx.sleep({ minutes: 1 })") + "ctx.".length)).toMatchObject({
      kind: "sleep",
      path: "0.1.0",
    });
    // A computed `ctx.all`'s member: the each node for the all call, its body's op for the inner call.
    expect(callAt(nodes, source.indexOf("ctx.all(threads.map") + "ctx.".length)).toMatchObject({
      kind: "each",
      path: "1",
    });
    // The call in the member, not the helper's higher up the file.
    const inMember = source.indexOf("ctx.forum.comments.list({ thread })", source.indexOf("ctx.all(threads.map"));
    expect(callAt(nodes, inMember + "ctx.forum.comments.".length)).toMatchObject({ kind: "op", path: "1.0.0" });
    // The call in a loop, and the computed one.
    expect(callAt(nodes, source.indexOf("ctx.bluesky.post.create({ text: thread })") + 4)).toMatchObject({
      path: "3.0.0",
    });
    expect(callAt(nodes, source.indexOf("[vendor].comments.list") + 1)).toMatchObject({
      kind: "op",
      id: "*.comments.list",
    });
    // Not a call's code: a branch's test, the end of a call.
    expect(callAt(nodes, source.indexOf("if (loud)") + 4)).toBeUndefined();
    expect(callAt(nodes, outline[6]!.span[1])).toBeUndefined();
  });

  it("offsetOf turns a frame's line and column, from 1, into an offset, or none past the end", () => {
    const source = "ab\ncd\n\nefg";
    expect(offsetOf(source, 1, 1)).toBe(0);
    expect(offsetOf(source, 2, 2)).toBe(4);
    expect(offsetOf(source, 4, 3)).toBe(9);
    expect(offsetOf(source, 5, 1)).toBeUndefined();
    expect(offsetOf(source, 0, 1)).toBeUndefined();
    // A column past the line's end is none, not the next line's start.
    expect(offsetOf(source, 1, 3)).toBeUndefined();
    expect(offsetOf(source, 4, 4)).toBeUndefined();
  });
});

describe("outlineWorkflow, spans", () => {
  it("reads the file that defined the workflow, and spans each node's code in it", () => {
    const { source, nodes, file } = outlined(announce);
    expect(file).toBe(announce.file);
    expect(source).toBe(readFileSync(announce.file, "utf8"));
    expect(source.slice(...nodes[0]!.span)).toBe('ctx.ghost.post.create({ title, html: body, status: "draft" })');
    for (const node of nodes.filter((n) => n.kind === "op")) {
      expect(source.slice(...node.span)).toMatch(/^ctx\.[\s\S]*\)$/);
    }
  });

  it("spans ctx.all, a loop, a .map callback and an if/else as the whole construct", () => {
    const { source, nodes } = outlined(busy);
    expect(nodes.map((node) => [node.kind, source.slice(...node.span)])).toEqual([
      ["all", expect.stringMatching(/^ctx\.all\(\[\n[\s\S]*\]\)$/)],
      ["each", "ctx.all(threads.map((thread) => () => ctx.forum.comments.list({ thread })))"],
      ["branch", expect.stringMatching(/^if \(loud\) [\s\S]*else console\.log\("nothing to say"\);$/)],
      ["repeat", expect.stringMatching(/^for \(const thread of threads\) \{[\s\S]*\}$/)],
      ["repeat", "for (let i = 0; i < threads.length; i++) await ctx.sleep({ ms: i });"],
      ["repeat", "threads.map((thread) => ctx.bluesky.post.create({ text: thread }))"],
      ["op", '(ctx as any)[vendor].comments.list({ thread: "x" })'],
    ]);
  });

  it("says why it cannot read the file: missing, unparsable, or without the workflow; there is no other source", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-outline-"));
    try {
      const why = (file: string) => unread({ ...busy, file });
      const missing = join(dir, "missing.ts");
      expect(why(missing)).toBe(`${missing} could not be read: ENOENT: no such file or directory, open '${missing}'`);
      const broken = join(dir, "broken.ts");
      writeFileSync(broken, 'export default defineWorkflow({ name: "busy", run: async (ctx) => { ');
      expect(why(broken)).toMatch(/could not be parsed: \S/);
      expect(why(broken).startsWith(`${broken} could not be parsed: `)).toBe(true);
      // Its name is no string, nor a top-level const holding one, so this is not the workflow named "busy".
      const elsewhere = join(dir, "elsewhere.ts");
      writeFileSync(
        elsewhere,
        'let name = "busy";\nexport default defineWorkflow({ name, run: async (ctx) => {} });\n',
      );
      expect(why(elsewhere)).toBe(`${elsewhere} holds no workflow named "busy"`);
      // A top-level const is read for its string, as the built-in drift names itself.
      const named = join(dir, "named.ts");
      writeFileSync(
        named,
        'export const NAME = "busy";\nexport default defineWorkflow({ name: NAME, run: async (ctx) => {} });\n',
      );
      expect(outlined({ ...busy, file: named })).toMatchObject({ file: named });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a .tsx file, with its JSX", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-outline-"));
    try {
      const tsx = join(dir, "announce.tsx");
      writeFileSync(tsx, `${readFileSync(announce.file, "utf8")}\nexport const view = () => <b>{announce.name}</b>;\n`);
      expect(outlined({ ...announce, file: tsx }).nodes).toEqual(outlined(announce).nodes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a file with \\r\\n line endings as if it had \\n", () => {
    const text = readFileSync(announce.file, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "sanoma-outline-"));
    try {
      const crlf = join(dir, "announce.ts");
      writeFileSync(crlf, text.replaceAll("\n", "\r\n"));
      const read = outlined({ ...announce, file: crlf });
      expect(read.file).toBe(crlf);
      expect(read.source).toBe(text);
      expect(read.nodes).toEqual(outlined(announce).nodes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The built package reads `run` as JavaScript. Builds dist/ when it is missing or older than src/ (`ensureBuilt`).
const dist = (file: string) => pathToFileURL(join(pkg, "dist", file)).href;

describe("outlineWorkflow, built", () => {
  it("outlines a workflow from its JavaScript source, in plain Node", () => {
    ensureBuilt();
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
      expect(realpathSync(outline.file)).toBe(realpathSync(script));
      const source = readFileSync(script, "utf8");
      const { nodes } = outline;
      expect(source.slice(...nodes[0]!.span)).toMatch(/^ctx\.all\(ids\.map\([\s\S]*\)$/);
      expect(source.slice(...nodes[1]!.span)).toBe("if (ids.length > 1) await ctx.sleep({ seconds: 1 });");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
