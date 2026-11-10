import { resend } from "@sanoma-ai/connector-resend";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { testDatabaseUrl, withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { describeConfig } from "sanoma/workflows/describe";
import { describe, expect, it } from "vitest";
import sendInvoice from "./fixtures/workflows/send-invoice.ts";
import { content, example } from "./helpers.ts";

// A workflow imports `sanoma/invoices/pdf` and calls `renderInvoice` itself, no connector between:
// the lint lets it, and a worker runs it, the PDF attached to the email it sends.
const email = fakeResend();
const config = { workflows: [sendInvoice], connectors: [withFake(resend, email)] };
const app = useTestApp(config, { databaseUrl: testDatabaseUrl("invoice_workflow") });

describe("a workflow that sends an invoice", () => {
  it("passes the workflow lint", () => {
    expect(describeConfig(config).workflows.find(({ name }) => name === "send-invoice")?.problems).toEqual([]);
  });

  it("renders the PDF and attaches it, whose name the ledger keeps and bytes leave out", async () => {
    const runId = await app.client.start(
      sendInvoice,
      { invoice: example(), to: "alex@example.com" },
      { startedBy: { id: "alice" } },
    );
    const { id } = (await app.client.result(runId)) as { id: string };
    const [attachment, ...others] = email.state.emails[id]?.attachments ?? [];
    expect(others).toEqual([]);
    expect(attachment?.filename).toBe("invoice-INV-001.pdf");
    const pages = await content(Uint8Array.from(Buffer.from(attachment!.content, "base64")));
    expect(pages[0]?.text).toContain("$225.00");
    const [called] = (await app.client.ledger(runId)).filter((record) => record.type === "op.called");
    expect(called).toMatchObject({
      op: "resend.emails.send",
      input: { attachments: [{ filename: "invoice-INV-001.pdf", content: "<content>" }] },
    });
  });
});
