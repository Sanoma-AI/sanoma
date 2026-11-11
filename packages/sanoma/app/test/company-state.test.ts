import { describe, expect, it } from "vitest";
import type { GoLiveRun } from "../src/api.ts";
import { type CompanyFacts, companyStateOf, hostAt } from "../src/lib/company-state.ts";

// A company's one state, read from facts: the table of which facts make which state, and where
// the host answers. Pure: server/company-state.ts gathers the facts (setup.test.ts renders them).

const HOST = "resources/sanoma/infra.ts#host";
const STORE = "resources/sanoma/infra.ts#store";

/** Going live's run in `status`, an apply's. */
const run = (status: GoLiveRun["status"], more: Partial<GoLiveRun> = {}): GoLiveRun => ({
  runId: "go:apply",
  workflow: "apply",
  status,
  ...more,
});

/** A fresh company on this computer, its template declaring Sanoma Cloud, nothing bound and never gone live. */
const fresh: CompanyFacts = { bound: [], place: "this-computer", declared: "cloud", repository: false, run: null };

/** Going live's lines for these facts, each line's name to whether it is done. */
const lines = (facts: Partial<CompanyFacts>) =>
  Object.fromEntries(companyStateOf({ ...fresh, ...facts }).lines.map(({ line, done }) => [line, done]));

describe("a company's state", () => {
  it("reads one state from the facts, never from how the company was made", () => {
    const table: [string, Partial<CompanyFacts>, string][] = [
      ["a fresh company", {}, "local"],
      ["a company that declares no host", { declared: null }, "local"],
      ["going live, queued", { run: run("queued") }, "deploying"],
      ["going live, waiting on an approval", { run: run("waiting") }, "deploying"],
      ["going live while the host is bound already", { run: run("running"), bound: [HOST] }, "deploying"],
      ["its host bound", { bound: [HOST], run: run("finished") }, "live"],
      ["its host bound, whatever an earlier run did", { bound: [HOST], run: run("failed") }, "live"],
      ["a hosted instance, nothing bound in its files", { place: "live" }, "live"],
      ["going live failed", { run: run("failed", { error: "boom" }) }, "failed"],
      ["going live cancelled", { run: run("cancelled") }, "failed"],
      [
        "going live finished with the host's step failed",
        { run: run("finished", { results: [{ id: HOST, action: "create", status: "failed", error: "no" }] }) },
        "failed",
      ],
      [
        "going live finished, the host skipped",
        { run: run("finished", { results: [{ id: HOST, action: "create", status: "skipped" }] }) },
        "local",
      ],
    ];
    for (const [what, facts, state] of table) {
      expect(companyStateOf({ ...fresh, ...facts }).state, what).toBe(state);
    }
  });

  it("is a drafting copy only live on this computer", () => {
    expect(companyStateOf({ ...fresh, bound: [HOST] }).draftingCopy).toBe(true);
    expect(companyStateOf({ ...fresh, place: "live", bound: [HOST] }).draftingCopy).toBe(false);
    expect(companyStateOf(fresh).draftingCopy).toBe(false);
  });

  it("ticks going live's lines from the bindings, and the last once the bound host answers", () => {
    expect(lines({})).toEqual({ repository: false, database: false, host: false, signIn: false });
    expect(lines({ repository: true, bound: [STORE] })).toEqual({
      repository: true,
      database: true,
      host: false,
      signIn: false,
    });
    const url = "https://acme.sanoma.work";
    expect(lines({ repository: true, bound: [STORE, HOST], host: { url } })).toMatchObject({
      host: true,
      signIn: false,
    });
    expect(lines({ bound: [STORE, HOST], host: { url, healthy: false } })).toMatchObject({ signIn: false });
    expect(lines({ bound: [STORE, HOST], host: { url, healthy: true } })).toMatchObject({ signIn: true });
    // An answer at an address the company has not bound is no sign-in.
    expect(lines({ host: { url, healthy: true } })).toMatchObject({ signIn: false });
  });

  it("finds the host where the latest apply says, else the latest drift check, else its declared hostname", () => {
    const applied = { url: "https://applied.example", wakeUrl: "https://wake.example", healthy: true };
    const checked = { url: "https://checked.example", healthy: false };
    expect(hostAt({ applied, checked, hostname: "acme.sanoma.work" })).toBe(applied);
    expect(hostAt({ checked, hostname: "acme.sanoma.work" })).toBe(checked);
    expect(hostAt({ hostname: "acme.sanoma.work" })).toEqual({ url: "https://acme.sanoma.work" });
    expect(hostAt({})).toBeUndefined();
  });
});
