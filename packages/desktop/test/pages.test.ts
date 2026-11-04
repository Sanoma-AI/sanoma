import { describe, expect, test } from "vitest";
import { type CompanyState, companyPage, folderNameOf, INSTALLING, QUIET_MS, STARTING, stepsOf } from "../src/pages.ts";
import { failureOf } from "../src/session.ts";

const state = (over: Partial<CompanyState> = {}): CompanyState => ({
  path: "/Users/a/Companies/acme",
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
    const early = companyPage(state(), 3_999);
    expect(early).toMatchObject({ opening: true, changesAt: 4_000 });
    expect(companyPage(state(), 4_000).opening).toBe(false);
  });

  test("shows the steps at once for a new company, a warning to read, or details asked for", () => {
    expect(companyPage(state({ kind: "new" }), 1_000).opening).toBe(false);
    expect(companyPage(state({ kind: "clone" }), 1_000).opening).toBe(false);
    expect(companyPage(state({ warning: "This folder is in iCloud" }), 1_000).opening).toBe(false);
    expect(companyPage(state({ details: true }), 1_000).opening).toBe(false);
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
  const opened = { kind: "open", progress: [], ready: false } as const;

  test("a configuration problem says so, in the launcher's words", () => {
    expect(failureOf(exit({ code: 2, error: "no workflows" }), opened)).toEqual({
      message: "The company's configuration has a problem (no workflows). Fix it, then start again.",
      pill: "Did not start",
    });
    expect(failureOf(exit({ code: 2 }), opened).message).toContain("the details below say what");
  });

  test("with only an exit code, a new company that never answered says it was setting up", () => {
    expect(failureOf(exit(), { kind: "new", progress: [], ready: false })).toEqual({
      message:
        "Setting up stopped before the app opened (exit code 1). The details below say why. Start again picks up where it stopped.",
      pill: "Not set up",
    });
  });

  test("a copy that failed says not copied, and git's line; later on it failed to start", () => {
    const failure = exit({ code: null, error: "GitHub did not let this computer in" });
    expect(failureOf(failure, { kind: "clone", progress: ["Cloning"], ready: false })).toEqual({
      message: "GitHub did not let this computer in",
      pill: "Not copied",
    });
    expect(failureOf(exit(), { kind: "clone", progress: ["Cloning", INSTALLING], ready: false }).pill).toBe(
      "Did not start",
    );
  });

  test("a company that had answered stopped, whichever way it began", () => {
    expect(failureOf(exit({ signal: "SIGSEGV" }), { kind: "new", progress: [], ready: true })).toEqual({
      message: "The company stopped (SIGSEGV).",
      pill: "Stopped",
    });
  });
});
