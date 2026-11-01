import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { petSittingExample, residentialCleaningExample } from "@sanoma-ai/invoices/examples";
import { testDatabaseUrl, waitFor } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { withSetup } from "@sanoma-ai/workflows";
import { describeConfig, outlineWorkflow } from "@sanoma-ai/workflows/describe";
import { afterAll, describe, expect, it } from "vitest";
import { fileSchema } from "../src/connector.ts";
import { invoicesDriver } from "../src/driver.ts";
import { invoices } from "../src/index.ts";
import generateInvoice from "./fixtures/generate.ts";

const root = mkdtempSync(join(tmpdir(), "sanoma-invoice-workflow-"));
mkdirSync(join(root, "resources"));
mkdirSync(join(root, "policies"));
mkdirSync(join(root, "scenarios"));
writeFileSync(
  join(root, "scenarios/cleaning.feature"),
  `Feature: Cleaning invoices
  Scenario: Clean a home
    Given alice is acting
    When generate-invoice runs with
      """
      ${JSON.stringify({ request: { document: { kind: "cleaning", invoice: residentialCleaningExample } } })}
      """
    Then an invoice PDF was generated for "HOME-001"
    And the run succeeds
`,
);
writeFileSync(
  join(root, "resources/people.ts"),
  'import { sanoma } from "sanoma/resources";\nexport const alice = sanoma.person({ id: "alice" });\n',
);
writeFileSync(
  join(root, "policies/invoices.cedar"),
  `@reason("This invoice is blocked")
forbid (principal, action == Sanoma::Action::"invoices.pdf.generate", resource)
when { resource == Sanoma::Target::"invoice/BLOCKED" };\n`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let calls = 0;
const driver = invoicesDriver();
const counted = {
  ...driver,
  ops: {
    "pdf.generate": async (...args: Parameters<NonNullable<(typeof driver.ops)["pdf.generate"]>>) => {
      calls++;
      return driver.ops["pdf.generate"]!(...args);
    },
  },
};
const config = { root, workflows: [generateInvoice], connectors: [withSetup(invoices, { driver: () => counted })] };

describe("invoice workflow", () => {
  const app = useTestApp(config, { databaseUrl: testDatabaseUrl("invoice_workflow"), quiet: true });
  const actor = { id: "alice" };

  it("is a normal operation in the workflow graph and passes author lint", () => {
    expect(outlineWorkflow(generateInvoice)).toMatchObject({
      nodes: [{ kind: "op", id: "invoices.pdf.generate" }, { kind: "branch" }],
    });
    const description = describeConfig(config);
    expect(description.workflows.find((workflow) => workflow.name === "generate-invoice")?.problems).toEqual([]);
  });

  it("recovers the exact checkpointed PDF after a restart without regenerating it", async () => {
    const before = calls;
    const runId = await app.client.start(
      generateInvoice,
      { request: { document: { kind: "pet-sitting", invoice: petSittingExample } }, review: true },
      { startedBy: actor },
    );
    await waitFor(async () => (await app.client.approvals(runId)).some((approval) => approval.status === "pending"));
    expect(calls - before).toBe(1);
    const stepsBefore = await app.raw.listWorkflowSteps(runId);
    await app.restart();
    await app.client.decide(runId, { decision: "approve", by: actor });
    const file = fileSchema.parse(await app.client.result(runId));
    expect(calls - before).toBe(1);
    expect(file.summary.dueMinor).toBe(18000);
    expect(Buffer.from(file.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(JSON.stringify(stepsBefore)).toContain(file.base64);
    const records = await app.client.ledger(runId);
    const op = records.filter((record) => record.type === "op.called");
    expect(op).toHaveLength(1);
    expect(op[0]).toMatchObject({
      op: "invoices.pdf.generate",
      effect: "read",
      attempt: 1,
      output: { base64: "<base64>" },
    });
  });

  it("runs the same cleaning schema in a sandbox with a real PDF result", async () => {
    const runId = await app.client.start(
      generateInvoice,
      { request: { document: { kind: "cleaning", invoice: residentialCleaningExample } } },
      { startedBy: actor, sandbox: "Clean a home" },
    );
    const file = fileSchema.parse(await app.client.result(runId));
    expect(file.summary.totalMinor).toBe(24000);
    expect(Buffer.from(file.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("applies policy before rendering", async () => {
    const before = calls;
    const runId = await app.client.start(
      generateInvoice,
      { request: { document: { kind: "pet-sitting", invoice: { ...petSittingExample, number: "BLOCKED" } } } },
      { startedBy: actor },
    );
    await expect(app.client.result(runId)).rejects.toThrow("This invoice is blocked");
    expect(calls).toBe(before);
    expect(await app.client.ledger(runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "op.called",
          op: "invoices.pdf.generate",
          decision: expect.objectContaining({ kind: "deny" }),
        }),
      ]),
    );
  });

  it("does not retry validation failures from the pure generator", async () => {
    const before = calls;
    const runId = await app.client.start(
      generateInvoice,
      { request: { document: { kind: "pet-sitting", invoice: { ...petSittingExample, paid: "181" } } } },
      { startedBy: actor },
    );
    await expect(app.client.result(runId)).rejects.toThrow("Check the invoice fields");
    expect(calls - before).toBe(1);
    expect(await app.client.ledger(runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "op.called",
          attempt: 1,
          error: expect.objectContaining({ vendorCode: "invalid_invoice", retryable: false }),
        }),
      ]),
    );
  });
});
