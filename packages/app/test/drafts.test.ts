import type { CheckResult, Source } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { checks } from "../src/server/drafts.ts";

// `checks`, a draft's card's: the source's check of the draft (`localGitSource`'s, run for real in
// `packages/sanoma/test/source.test.ts`), without the grid.

describe("checks", () => {
  it("asks the source to check the draft and keeps its result but the grid", async () => {
    const asked: string[] = [];
    const checked: CheckResult = {
      ok: false,
      problems: ["workflows/a.ts:1:1: no"],
      warnings: ["sites/www/routes/index.tsx:1:1: warning: maybe"],
      grid: { groups: [null], workflows: [], ops: [] },
    };
    const source = {
      root: "/repo",
      commit: () => undefined,
      head: () => "HEAD",
      check: async (id: string) => (asked.push(id), checked),
    } satisfies Source;
    expect(await checks({ source }, "chat-1")).toEqual({
      ok: false,
      problems: checked.problems,
      warnings: checked.warnings,
    });
    expect(asked).toEqual(["chat-1"]);
  });

  it("is one problem when the repository cannot check a draft", async () => {
    const source: Source = { root: "/repo", commit: () => undefined, head: () => "HEAD" };
    for (const app of [{ source }, {}]) {
      expect(await checks(app, "chat-1")).toEqual({
        ok: false,
        problems: ["sanoma check: this instance's repository cannot check a draft"],
        warnings: [],
      });
    }
  });
});
