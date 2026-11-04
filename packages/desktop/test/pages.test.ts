import { describe, expect, test } from "vitest";
import { type CompanyState, companyPage, folderNameOf, INSTALLING, QUIET_MS, STARTING, stepsOf } from "../src/pages.ts";
import { failureOf } from "../src/session.ts";

const state = (over: Partial<CompanyState> = {}): CompanyState => ({
  name: "acme",
  place: "~/Companies/acme",
  kind: "open",
  phase: "starting",
  progress: [],
  log: { start: 1, skipped: 0, lines: [] },
  startedAt: 1_000,
  lastOutputAt: 1_000,
  details: false,
  reopens: true,
  bringsBack: "Dock",
  ...over,
});

const statuses = (over: Partial<CompanyState>) => stepsOf(state(over)).map((step) => step.status);

describe("a start's steps", () => {
  test("are all there from the beginning, the first one under way", () => {
    expect(stepsOf(state())).toEqual([
      { label: "Installing what it needs", status: "now" },
      { label: "Starting the company", status: "next" },
    ]);
  });

  test("follow what an open reports", () => {
    expect(statuses({ progress: [INSTALLING] })).toEqual(["now", "next"]);
    expect(statuses({ progress: [INSTALLING, STARTING] })).toEqual(["done", "now"]);
  });

  test("a new company has two: setting up, until its database event, and starting", () => {
    const steps = stepsOf(state({ kind: "new", progress: ["Starting a new company with sanoma from npm"] }));
    expect(steps.map((step) => step.label)).toEqual(["Setting up the company", "Starting it"]);
    expect(steps.map((step) => step.status)).toEqual(["now", "next"]);
    expect(statuses({ kind: "new", progress: ["Starting a new company with sanoma from npm", STARTING] })).toEqual([
      "done",
      "now",
    ]);
  });

  test("a new company tried again, in a folder that got that far, reports as an open does", () => {
    expect(statuses({ kind: "new", progress: [INSTALLING] })).toEqual(["now", "next"]);
    expect(statuses({ kind: "new", progress: [INSTALLING, STARTING] })).toEqual(["done", "now"]);
  });

  test("a copy from GitHub has one more in front, done when the copy is there already", () => {
    expect(statuses({ kind: "clone", progress: ["Cloning"] })).toEqual(["now", "next", "next"]);
    expect(statuses({ kind: "clone", progress: ["Cloning", INSTALLING] })).toEqual(["done", "now", "next"]);
    expect(statuses({ kind: "clone", progress: [INSTALLING] })).toEqual(["done", "now", "next"]);
  });

  test("the last stays under way while the app loads, and is done once only Got it holds it back", () => {
    const progress = [INSTALLING, STARTING];
    expect(statuses({ phase: "running", progress })).toEqual(["done", "now"]);
    expect(statuses({ phase: "running", progress, warning: "This folder is in iCloud" })).toEqual(["done", "done"]);
  });
});

describe("a company's page", () => {
  test("an open shows one word for 3 seconds, then its steps, and redraws itself then", () => {
    expect(companyPage(state(), 3_999)).toMatchObject({ current: "Opening", listed: false, changesAt: 4_000 });
    const later = companyPage(state(), 4_000);
    expect(later).toMatchObject({ listed: true, layout: "column", controls: true });
    expect(later.current).toBeUndefined();
  });

  test("shows the steps at once for a new company or a warning to read", () => {
    expect(companyPage(state({ kind: "new" }), 1_000).listed).toBe(true);
    expect(companyPage(state({ kind: "clone" }), 1_000).listed).toBe(true);
    expect(companyPage(state({ warning: "This folder is in iCloud" }), 1_000).listed).toBe(true);
  });

  test("with details asked for, the output takes the list's place and the step goes beside the name", () => {
    expect(companyPage(state({ details: true }), 1_000)).toMatchObject({
      layout: "wide",
      output: true,
      listed: false,
      current: "Installing what it needs",
      controls: true,
    });
    // Nothing under way when only Got it holds the app back.
    const held = { details: true, phase: "running", warning: "This folder is in iCloud" } as const;
    expect(companyPage(state(held), 1_000).current).toBeUndefined();
  });

  test("a failure opens its output whatever was asked, until its page hides it; its Hide replaces the controls", () => {
    const failed = state({ phase: "failed", details: false });
    expect(companyPage(failed, 0)).toMatchObject({ layout: "wide", output: true, controls: false, listed: false });
    expect(companyPage(failed, 0, true)).toMatchObject({ layout: "wide", output: false, controls: true });
    expect(companyPage(state({ phase: "stopped" }), 0)).toMatchObject({
      layout: "wide",
      output: false,
      controls: true,
    });
  });

  test("only a new company says how long and that the window may close, naming what brings it back", () => {
    expect(companyPage(state({ kind: "new", bringsBack: "tray" }), 1_000)).toMatchObject({
      note: "This takes about a minute, the first time.",
      closing: expect.stringContaining("the tray icon brings it back"),
    });
    const opened = companyPage(state(), 5_000);
    expect(opened.note).toBeUndefined();
    expect(opened.closing).toBeUndefined();
    expect(companyPage(state({ kind: "new", phase: "failed" }), 1_000).note).toBeUndefined();
  });

  test("says a start has gone quiet at 2 minutes without a line, and again when a line comes", () => {
    const quietAt = 1_000 + QUIET_MS;
    expect(companyPage(state(), quietAt - 1)).toMatchObject({ quiet: false, changesAt: quietAt });
    const quiet = companyPage(state(), quietAt);
    expect(quiet.quiet).toBe(true);
    expect(quiet.changesAt).toBeUndefined();
    expect(companyPage(state({ lastOutputAt: quietAt }), quietAt).quiet).toBe(false);
  });

  test("is not quiet once the company has ended or its app answers", () => {
    for (const phase of ["running", "failed", "stopped"] as const) {
      expect(companyPage(state({ phase }), 1_000 + QUIET_MS)).toMatchObject({ quiet: false, changesAt: undefined });
    }
  });

  test("a failed company that was opened tells whoever did not set it up to send the details", () => {
    expect(companyPage(state({ phase: "failed", pill: "Did not start" }), 0)).toMatchObject({
      ended: true,
      sendDetails: true,
      pill: "Did not start",
    });
    expect(companyPage(state({ phase: "failed", kind: "new" }), 0).sendDetails).toBe(false);
    expect(companyPage(state({ phase: "stopped" }), 0)).toMatchObject({ sendDetails: false, pill: "Stopped" });
  });
});

describe("a new company's folder", () => {
  test.each([
    ["Northside Plumbing", "northside-plumbing"],
    ["  Café & Bar, Inc. ", "cafe-bar-inc"],
    ["acme", "acme"],
    ["北京 Tea", "北京-tea"],
    ["../..", ""],
    ["   ", ""],
    ["हिन्दी", "हिन्दी"],
    ["がく", "がく"],
    ["Aux", "aux-company"],
    ["COM1", "com1-company"],
    ["Aux Body Shop", "aux-body-shop"],
  ])("%j goes in %j", (name, folder) => {
    expect(folderNameOf(name)).toBe(folder);
  });
});

const exit = (over: { code?: number | null; signal?: NodeJS.Signals | null; error?: string } = {}) => ({
  code: 1,
  signal: null,
  ...over,
});

describe("why a session ended", () => {
  const opened = { kind: "open", phase: "starting", progress: [] } satisfies Parameters<typeof failureOf>[1];

  test("a configuration problem says so, in the launcher's words", () => {
    expect(failureOf(exit({ code: 2, error: "no workflows" }), opened)).toEqual({
      message: "The company's configuration has a problem (no workflows). Fix it, then start again.",
      pill: "Did not start",
    });
    expect(failureOf(exit({ code: 2 }), opened).message).toContain("the details below say what");
  });

  test("with only an exit code, a new company that never answered says it was setting up", () => {
    expect(failureOf(exit(), { kind: "new", phase: "starting", progress: [] })).toEqual({
      message:
        "Setting up stopped before the app opened (exit code 1). The details below say why. Start again picks up where it stopped.",
      pill: "Not set up",
    });
  });

  test("a copy that failed says not copied, and git's line; later on it failed to start", () => {
    const failure = exit({ code: null, error: "GitHub did not let this computer in" });
    expect(failureOf(failure, { kind: "clone", phase: "starting", progress: ["Cloning"] })).toEqual({
      message: "GitHub did not let this computer in",
      pill: "Not copied",
    });
    expect(failureOf(exit(), { kind: "clone", phase: "starting", progress: ["Cloning", INSTALLING] }).pill).toBe(
      "Did not start",
    );
  });

  test("a company that had answered stopped, whichever way it began", () => {
    expect(failureOf(exit({ signal: "SIGSEGV" }), { kind: "new", phase: "running", progress: [] })).toEqual({
      message: "The company stopped (SIGSEGV).",
      pill: "Stopped",
    });
  });
});
