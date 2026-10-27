import { CHANGE_MERGE, changeIdOf } from "@sanoma-ai/workflows/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, startApp } from "../src/index.ts";
import { asChangeRef, groupFiles, phaseLabel } from "../src/lib/changes.ts";
import { cellWords, diffGrids } from "../src/lib/grid-diff.ts";
import { barLabels } from "./bar-helpers.ts";
import { REFUNDS_WAIT, useChangeApp } from "./fixtures/change.ts";

// The Changes section and a change's review: the words and groups (`lib/changes.ts`), then a real
// change of a draft that edits `policies/`, over C5's fake host, as the server renders its pages.
// Needs Postgres (`pnpm db:up`) and the built app.

describe("a change's words", () => {
  it("names each phase, Publish waiting by its approver", () => {
    expect(phaseLabel({ phase: "waiting", decision: { answer: "hold", approver: { group: "admin" } } })).toBe(
      "Waiting for admin",
    );
    expect(phaseLabel({ phase: "waiting", decision: { answer: "allow", approver: "alice" } })).toBe(
      "Waiting for alice",
    );
    expect(phaseLabel({ phase: "merged" })).toBe("Published");
    expect(
      ["opening", "checking", "planning", "merging", "deploying", "closed", "blocked"].map((phase) =>
        phaseLabel({ phase: phase as "opening" }),
      ),
    ).toEqual(["Opening", "Checking", "Planning", "Merging", "Deploying", "Closed", "Blocked"]);
  });

  it("groups the files by kind, then each app's, then the rest", () => {
    expect(
      groupFiles([
        "README.md",
        "apps/crm/policies/x.cedar",
        "sites/www/index.tsx",
        "workflows/refund.ts",
        "resources/people.ts",
        "apps/books/workflows/a.ts",
        "scenarios/refund.feature",
        "resources/finance/cards.ts",
        "policies/money.cedar",
      ]),
    ).toEqual([
      { key: "policies", title: "Policies", files: ["policies/money.cedar"] },
      { key: "people", title: "People", files: ["resources/people.ts"] },
      { key: "resources", title: "Resources", files: ["resources/finance/cards.ts"] },
      { key: "workflows", title: "Workflows", files: ["workflows/refund.ts", "scenarios/refund.feature"] },
      { key: "sites", title: "Sites", files: ["sites/www/index.tsx"] },
      { key: "app:books", title: "App books", files: ["apps/books/workflows/a.ts"] },
      { key: "app:crm", title: "App crm", files: ["apps/crm/policies/x.cedar"] },
      { key: "other", title: "Other files", files: ["README.md"] },
    ]);
  });

  it("reads Publish's details as a change, and nothing else", () => {
    const ref = {
      change: { id: "rules", title: "Rules", branch: "draft/rules" },
      facts: { touches: ["policies/"], strandedRuns: 0, stranded: [], checksOk: true, rules: true },
    };
    expect(asChangeRef(JSON.stringify(ref))).toEqual(ref);
    expect(asChangeRef(ref)).toEqual(ref);
    expect(asChangeRef("Refund 40")).toBeUndefined();
    expect(asChangeRef(JSON.stringify({ problems: [], rebinds: [], steps: [] }))).toBeUndefined();
    expect(asChangeRef(JSON.stringify({ change: { id: "x" }, facts: { touches: [] } }))).toBeUndefined();
  });

  it("finds a change run's draft", () => {
    expect(changeIdOf("change:rules")).toBe("rules");
    expect(changeIdOf("change:rules~2")).toBe("rules");
    expect(changeIdOf("change:rules:deploy")).toBeUndefined();
    expect(changeIdOf("0b5d4c1e")).toBeUndefined();
  });
});

describe("the Changes section", () => {
  const fixture = useChangeApp("changes");
  let runId: string;
  /** The app over the same config with no repository, so no remote. */
  let bare: App;

  beforeAll(async () => {
    runId = await fixture.draft(
      "rules",
      { "policies/refunds.cedar": REFUNDS_WAIT },
      { title: "Refunds wait for finance" },
    );
    bare = await startApp(fixture.testApp.config, { port: 0 });
  }, 60_000);
  afterAll(async () => {
    await bare?.close();
  });

  it("puts Changes after Inbox in the bar when the repository has a remote, and not without one", async () => {
    const { html } = await fixture.page("/inbox");
    expect(barLabels(html)[0]).toEqual(["Inbox", "Changes", "Workflows"]);
    const without = await (await fetch(new URL("/inbox", bare.url))).text();
    expect(barLabels(without)[0]).toEqual(["Inbox", "Workflows"]);
  });

  it("lists the open change, and says how one opens when none is done", async () => {
    const open = await fixture.page("/changes");
    expect(open.status).toBe(200);
    expect(open.html).toMatch(/<h1[^>]*>Changes<span[^>]*>1<\/span><\/h1>/);
    expect(open.html).toContain('href="/changes/rules"');
    expect(open.html).toContain(">Refunds wait for finance</a>");
    expect(open.html).toContain("Waiting for admin");
    const pr = fixture.remote.pullOf("draft/rules")!;
    expect(open.html).toContain(`href="${pr.url}"`);
    expect(open.html).toContain(`#${pr.number} <span aria-hidden="true">↗</span>`);

    const done = await fixture.page("/changes?show=done");
    expect(done.html).toContain("No change is done yet");
    expect(done.html).toContain("A change opens when you send a draft for review.");
  });

  it("reviews the change: its phase, its files by kind, the grid diffed, the answer and Publish", async () => {
    const { status, html } = await fixture.page("/changes/rules");
    expect(status).toBe(200);
    expect(html).toMatch(/<h1[^>]*>Refunds wait for finance<\/h1>/);
    expect(html).toContain("Waiting for admin");
    expect(html).toContain("<code>draft/rules</code>");
    expect(html).toContain('href="/workflows/change/runs/change%3Arules"');
    // What changed, by kind.
    expect(html).toContain(">What changed</h2>");
    expect(html).toContain(">Policies</h3>");
    expect(html).toContain("policies/refunds.cedar</code>");
    // Who may do what: main's grid against the branch's, a changed cell's words.
    expect(html).toContain(">Who may do what</h2>");
    const diff = diffGrids(fixture.gridWith({}), fixture.gridWith({ "policies/refunds.cedar": REFUNDS_WAIT }));
    const changed = diff.workflows.find((row) => row.id === "refund")!.cells.find((cell) => cell.change !== "same")!;
    expect(cellWords(changed)).toBe("allow → hold · group finance");
    expect(html).toContain(cellWords(changed));
    // The decision floating: the runtime's hold for admin, the checks, and Publish.
    expect(html).toContain("Publish waits for admin");
    expect(html).toContain("A change to the rules waits for admin");
    expect(html).toMatch(/<dt[^>]*>Checks<\/dt><dd[^>]*>pass<\/dd>/);
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
    expect(html).toContain("Rejecting closes the change.");
  });

  it("links the change from Publish in the Inbox", async () => {
    const publish = (await fixture.testApp.client.approvals(runId)).find((a) => a.covers.includes(CHANGE_MERGE))!;
    const { html } = await fixture.page(`/inbox?approval=${encodeURIComponent(`${runId}/${publish.id}`)}`);
    expect(html).toMatch(
      /<dt[^>]*>Change<\/dt><dd[^>]*><a [^>]*href="\/changes\/rules"[^>]*>Refunds wait for finance<\/a>/,
    );
    expect(html).toContain('aria-label="What the change edits"');
    // Decided as Publish here too.
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Publish<\/button>/);
    // The glance in place of the details' JSON.
    expect(html).not.toContain("&quot;touches&quot;");
  });

  it("leads from the change's run to its review", async () => {
    const { html } = await fixture.page(`/workflows/change/runs/${encodeURIComponent(runId)}`);
    expect(html).toMatch(/<a [^>]*href="\/changes\/rules"[^>]*>Review<\/a>/);
  });

  it("shows Published once admin publishes it, and lists it as done", async () => {
    await fixture.testApp.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    await fixture.testApp.client.result(runId);
    const { html } = await fixture.page("/changes/rules");
    expect(html).toContain("Published");
    expect(html).toMatch(/<dt[^>]*>Merged<\/dt>/);
    expect(html).not.toContain("Rejecting closes the change.");
    const done = await fixture.page("/changes?show=done");
    // One row per draft: its latest run's.
    expect(done.html.match(/href="\/changes\/rules"/g)).toHaveLength(1);
  });

  it("lists a draft once, by its latest run: open again, it leaves Done", async () => {
    const again = await fixture.draft("rules", { "policies/more.cedar": "\n" }, { title: "More rules" });
    expect(again).toBe("change:rules~2");
    const open = await fixture.page("/changes");
    expect(open.html.match(/href="\/changes\/rules"/g)).toHaveLength(1);
    expect(open.html).toContain(">More rules</a>");
    expect((await fixture.page("/changes?show=done")).html).not.toContain('href="/changes/rules"');
    await fixture.testApp.client.changeEvent("rules", { kind: "close", by: "alice" }, { by: "alice" });
    await fixture.testApp.client.result(again);
  });

  it("is not found for a draft with no change", async () => {
    const { status, html } = await fixture.page("/changes/nothing");
    expect(status).toBe(404);
    expect(html).toContain("No change nothing.");
  });
});
