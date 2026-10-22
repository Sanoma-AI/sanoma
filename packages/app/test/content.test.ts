import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tree } from "../../workflows/test/tree.ts";
import { CONTENT_TYPES, contentTypes, readContent } from "../src/content-files.ts";

// The repo's content: `readContent`, what the build hands a site's `content`, and `contentTypes`,
// the `.sanoma/content.ts` that types it, type-checked as a site's tsconfig would.

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const src = fileURLToPath(new URL("../src/", import.meta.url));
const tscBin = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

const posts = {
  "content/posts/zapier.md": `---
title: Sanoma and Zapier
description: How they differ.
lastChecked: 2026-10-01
comparison:
  - topic: Pricing
    competitor: Per task
    source: https://zapier.com/pricing
    sanoma: Free to self-host
    status: checked
  - topic: Code
    competitor: None
    source: https://zapier.com
    sanoma: Every workflow
    status: draft
---

A comparison.

| Topic | Sanoma |
| ----- | ------ |
| Price | Free   |
`,
  "content/posts/hello.md": `---
title: Hello
description: The first post.
draft: true
---
Hi <b>there</b>.
`,
};

describe("readContent", () => {
  it("reads each kind's files, sorted by slug: front matter as data, the body as written and as HTML", () => {
    const repo = tree("posts", posts);
    const { kinds, problems } = readContent(repo, { drafts: true });
    expect(problems).toEqual([]);
    expect(Object.keys(kinds)).toEqual(["posts"]);
    const [hello, zapier] = kinds.posts!;
    expect(hello).toEqual({
      slug: "hello",
      data: { title: "Hello", description: "The first post.", draft: true },
      body: "Hi <b>there</b>.\n",
      // Raw HTML passes through: content is reviewed as code is.
      html: "<p>Hi <b>there</b>.</p>\n",
    });
    expect(zapier!.slug).toBe("zapier");
    // An unquoted date stays a string (YAML 1.2), as a page serialises it.
    expect(zapier!.data.lastChecked).toBe("2026-10-01");
    expect(zapier!.data.comparison).toEqual([
      expect.objectContaining({ topic: "Pricing", status: "checked" }),
      expect.objectContaining({ topic: "Code", status: "draft" }),
    ]);
    expect(zapier!.body.startsWith("\nA comparison.")).toBe(true);
    // A GFM table.
    expect(zapier!.html).toContain("<table>");
    expect(zapier!.html).toContain("<td>Free</td>");
  });

  it("leaves a draft out without drafts", () => {
    const repo = tree("drafts", posts);
    expect(readContent(repo, { drafts: false }).kinds.posts!.map((p) => p.slug)).toEqual(["zapier"]);
  });

  it("reads a file with no front matter as {}, and ignores subfolders, dotfiles and other files", () => {
    const repo = tree("plain", {
      "content/notes/plain.md": "# Just Markdown\n",
      "content/notes/empty.md": "---\n---\nNothing above.\n",
      "content/notes/later.mdx": "---\ntitle: MDX\n---\n",
      "content/notes/image.png": "",
      "content/notes/nested/deep.md": "---\ntitle: Deep\n---\n",
      "content/README.md": "Not a kind.\n",
      "content/.obsidian/workspace.md": "An editor's.\n",
      "content/notes/.draft.md": "A dotfile.\n",
      // A byte order mark, as some editors save one.
      "content/notes/bom.md": "\uFEFF---\ntitle: Marked\n---\nAfter a BOM.\n",
    });
    const { kinds, problems } = readContent(repo, { drafts: false });
    expect(problems).toEqual([]);
    expect(kinds.notes!.map(({ slug, data, html }) => ({ slug, data, html }))).toEqual([
      { slug: "bom", data: { title: "Marked" }, html: "<p>After a BOM.</p>\n" },
      { slug: "empty", data: {}, html: "<p>Nothing above.</p>\n" },
      { slug: "plain", data: {}, html: "<h1>Just Markdown</h1>\n" },
    ]);
  });

  it("has no kinds without content/", () => {
    expect(readContent(tree("none"), { drafts: true })).toEqual({ kinds: {}, problems: [] });
  });

  it("reports bad front matter at its line, and a folder or file whose name is not a URL segment, leaving each out", () => {
    const repo = tree("bad", {
      "content/posts/good.md": "---\ntitle: Good\n---\n",
      "content/posts/bad.md": "---\ntitle: ok\ndescription: [unclosed\n---\nBody.\n",
      "content/posts/list.md": "---\n- a\n- b\n---\n",
      "content/posts/open.md": "---\ntitle: Never closed\n\nBody.\n",
      // Aliases that would expand past what yaml allows.
      "content/posts/aliases.md": `---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [${"*a,".repeat(9)}*a]\nc: &c [${"*b,".repeat(9)}*b]\nd: [${"*c,".repeat(9)}*c]\n---\n`,
      "content/posts/Not_A_Slug.md": "---\ntitle: X\n---\n",
      "content/Blog/post.md": "---\ntitle: X\n---\n",
    });
    const { kinds, problems } = readContent(repo, { drafts: true });
    expect(kinds).toEqual({ posts: [expect.objectContaining({ slug: "good" })] });
    expect(problems).toEqual([
      {
        file: "content/Blog",
        line: 1,
        column: 1,
        message:
          "a content folder's name is a URL segment (a lowercase letter, then lowercase letters, digits and dashes)",
      },
      {
        file: "content/posts/Not_A_Slug.md",
        line: 1,
        column: 1,
        message:
          "a content file's name is a URL segment (a lowercase letter, then lowercase letters, digits and dashes)",
      },
      {
        file: "content/posts/aliases.md",
        line: 2,
        column: 1,
        message: "front matter: Excessive alias count indicates a resource exhaustion attack",
      },
      {
        file: "content/posts/bad.md",
        line: 3,
        column: 23,
        message: "front matter: Flow sequence in block collection must be sufficiently indented and end with a ]",
      },
      { file: "content/posts/list.md", line: 2, column: 1, message: "front matter is a mapping of names to values" },
      { file: "content/posts/open.md", line: 1, column: 1, message: "front matter: no closing `---` line" },
    ]);
  });
});

describe("contentTypes", () => {
  it("types each kind by the union of its files' front matter: a key in every file required, rows merged", () => {
    const repo = tree("types", {
      ...posts,
      "content/docs/start.md": '---\ntitle: Start\n"x-order": 1\ntags: []\n---\n',
      "content/docs/more.md": "---\ntitle: More\nx-order: null\ntags: [a, 2]\n---\n",
    });
    expect(contentTypes(readContent(repo, { drafts: true }).kinds))
      .toBe(`// Generated by sanoma from content/; do not edit.
import type { ContentKind } from "sanoma/site";

interface CompanyContent {
  /** content/docs: 2 files. */
  docs: ContentKind<{ title: string; "x-order": null | number; tags: (string | number)[] }>;
  /** content/posts: 2 files. */
  posts: ContentKind<{ title: string; description: string; draft?: boolean; lastChecked?: string; comparison?: { topic: string; competitor: string; source: string; sanoma: string; status: string }[] }>;
}

declare module "sanoma/site" {
  interface Register {
    content: CompanyContent;
  }
}

export {};
`);
  });

  it("declares no kind without content", () => {
    expect(contentTypes({})).toContain("interface CompanyContent {}");
  });

  it("types a site's content: a kind's front matter, and neither a key nor a kind the files lack", () => {
    const repo = tree("typed", {
      ...posts,
      "package.json": JSON.stringify({ type: "module" }),
      // `sanoma/site` in miniature: `content` and `Register`, as the app's site.ts exports them.
      "site.ts": `export * from ${JSON.stringify(join(src, "content.ts"))};
export type { Register } from ${JSON.stringify(join(src, "api-client.ts"))};
`,
      "page.ts": `import { content, type ContentSummary } from "sanoma/site";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export async function page() {
  const post = await content.posts.get("zapier");
  const title: string | undefined = post?.data.title;
  const html: string | undefined = post?.html;
  const rows = post?.data.comparison?.map((row) => row.competitor);
  const list = await content.posts.list();
  const draft: Equal<(typeof list)[number]["data"]["draft"], boolean | undefined> = true;
  const summary: ContentSummary<unknown> = list[0]!;
  // @ts-expect-error: no post has nope
  const nope = post?.data.nope;
  // @ts-expect-error: no content/nope
  await content.nope.list();
  return [title, html, rows, draft, summary, nope];
}
`,
    });
    mkdirSync(join(repo, ".sanoma"));
    writeFileSync(join(repo, CONTENT_TYPES), contentTypes(readContent(repo, { drafts: true }).kinds));
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        extends: join(checkout, "tsconfig.json"),
        // The root's paths, which these replace, for what api-client.ts imports.
        compilerOptions: {
          paths: {
            "sanoma/site": ["./site.ts"],
            "@sanoma-ai/workflows": [join(checkout, "packages/workflows/src/index.ts")],
            "@sanoma-ai/workflows/*": [join(checkout, "packages/workflows/src/*.ts")],
          },
        },
        // As a company's sites tsconfig: the app's ambient types, which declare the virtual module.
        include: ["page.ts", CONTENT_TYPES, join(src, "env.d.ts")],
        exclude: [],
      }),
    );
    const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--pretty", "false"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(tsc.stdout).toBe("");
    expect(tsc.status).toBe(0);
  }, 60_000);
});
