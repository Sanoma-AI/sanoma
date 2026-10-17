import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt, testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { allowAll, defineConfig, memoryLedger, SanomaClient, startWorker, type Worker } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyFakes } from "../../workflows/test/fixtures/company/fakes.ts";
import { type App, startApp } from "../src/index.ts";
import { asApplyPlan, exportName, plannedRows, rebindWords, shortId, STEP_GROUPS } from "../src/lib/apply-plan.ts";
import { PLAN } from "./fixtures/apply-plan.ts";
import reviewPlan from "./fixtures/review-plan.ts";

describe("the change view's words", () => {
  it("tells an apply plan in an approval's details by its shape, as JSON or as itself", () => {
    expect(asApplyPlan(JSON.stringify(PLAN))).toEqual(PLAN);
    expect(asApplyPlan(PLAN)).toBe(PLAN);
    for (const other of [undefined, "", "Email to newsletter", "{", "[]", JSON.stringify({ steps: [] }), 3]) {
      expect(asApplyPlan(other), String(other)).toBeUndefined();
    }
  });

  it("says each change to the lockfile in plain words", () => {
    const key = "resources/sanoma/infra.ts#store";
    const type = "supabase.project";
    expect(
      rebindWords({ key, type, kind: "rebind", from: "abcdefghijklmnop", to: "wxyzabcdefghijkl" }, "project"),
    ).toBe("points store at a different project: abcdefgh… → wxyzabcd…");
    expect(rebindWords({ key, type, kind: "bind", to: "abcdefghijklmnop" }, "project")).toBe(
      "points store at an existing project: abcdefgh…",
    );
    expect(rebindWords({ key, type, kind: "unbind", from: "R_docs" }, "repository")).toBe(
      "forgets which repository store is: it was R_docs",
    );
  });

  it("shortens only a long id, and names a declaration by its export", () => {
    expect(shortId("R_docs")).toBe("R_docs");
    expect(shortId("R_kgDOabcd1234")).toBe("R_kgDOab…");
    expect(exportName("resources/identity/github.ts#websiteMain")).toBe("websiteMain");
  });

  it("has a group for each kind of step, each in the fixture once", () => {
    expect(STEP_GROUPS.map(([action]) => action)).toEqual(PLAN.steps.map((s) => s.action));
  });

  it("lists a create's planned fields, then each the vendor fills in, known after apply", () => {
    expect(plannedRows({ planned: { name: "blog", node_id: null }, unknown: ["node_id", "owner.id"] })).toEqual([
      { path: "name", value: "blog", known: true },
      { path: "node_id", known: false },
      { path: "owner.id", known: false },
    ]);
  });
});

describe("the change view in the app", () => {
  const appDir = fileURLToPath(new URL("..", import.meta.url));
  const companyDir = fileURLToPath(new URL("../../workflows/test/fixtures/company/", import.meta.url));
  // The company's data files, its lockfile also binding a declaration no data file has.
  const root = mkdtempSync(join(tmpdir(), "sanoma-app-plan-"));
  cpSync(join(companyDir, "resources"), join(root, "resources"), { recursive: true });
  const lockfile = join(root, "resources/sanoma.lock.json");
  const bindings = JSON.parse(readFileSync(lockfile, "utf8")) as Record<string, unknown>;
  bindings["resources/old.ts#legacy"] = { type: "github.repository", id: "R_kgDOlegacy99" };
  writeFileSync(lockfile, JSON.stringify(bindings));
  const company = companyFakes();
  const config = defineConfig({
    workflows: [reviewPlan],
    connectors: company.connectors,
    policy: allowAll,
    ledger: memoryLedger(),
    databaseUrl: testDatabaseUrl("app_plan"),
    root,
  });
  let worker: Worker;
  let app: App;
  let client: SanomaClient;
  const page = async (path: string) => {
    const res = await fetch(new URL(path, app.url));
    return { status: res.status, text: (await res.text()).replaceAll("<!-- -->", "") };
  };

  beforeAll(async () => {
    ensureBuilt(appDir, ["dist/server/server.js"], ["pnpm", "exec", "vite", "build"]);
    worker = await startWorker(config);
    app = await startApp(config, { port: 0 });
    client = await SanomaClient.connect(config);
  });
  afterAll(async () => {
    await app?.close();
    await client?.close();
    await worker?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("renders a plan in its approval: the problem, the rebind in plain words, and every kind of step", async () => {
    const runId = await client.start(reviewPlan, {}, { startedBy: { id: "tester" } });
    const [approval] = await waitFor(
      () => client.approvals(runId),
      (all) => all.some((a) => a.status === "pending"),
    );
    const open = await page(`/inbox?approval=${runId}/${approval!.id}`);
    expect(open.status).toBe(200);
    for (const words of [
      "1 problem in the data files: their resources are left out</div>",
      "Rebinds: changes to the lockfile apply did not make",
      "points docs at a different repository: R_kgDOab… → R_kgDOwx…",
      "Create (1)",
      "known after apply",
      "Update (1)",
      "Replace: delete, then create (1)",
      "<code>pattern</code> cannot change in place",
      "Bind to an existing object (1)",
      "which its identity found at the vendor",
      "Gone at the vendor (1)",
      "Apply asks whether to recreate it",
      "No longer declared (1)",
      "Apply asks whether to forget the binding or delete the object at the vendor.",
      "1 resource unchanged",
    ]) {
      expect(open.text).toContain(words);
    }
    // An update's fields, as declared and as the vendor holds them.
    expect(open.text).toMatch(/<code>has_wiki<\/code>.*?<code>false<\/code>.*?<code>true<\/code>/s);
    await client.decide(runId, { decision: "approve", by: { id: "marketing-lead" } }, approval!.id);
    await waitFor(
      () => client.run(runId),
      (run) => run?.status === "finished",
    );
  });

  it("shows each resource's binding, the orphaned ones, and Apply", async () => {
    const resources = await page("/resources");
    expect(resources.status).toBe(200);
    expect(resources.text).toContain(">Bound to</th>");
    expect(resources.text).toContain('title="R_website">R_website</code>');
    expect(resources.text).toContain('title="prod_SanomaFixtureBasic">prod_San…</code>');
    expect(resources.text).toContain("Bound, no longer declared");
    expect(resources.text).toMatch(/<code[^>]*>resources\/old\.ts#legacy<\/code>.*?title="R_kgDOlegacy99">R_kgDOle…/s);
    expect(resources.text).toMatch(/<button(?![^>]*disabled)[^>]*>.*?Apply<\/button>/s);
  });
});
