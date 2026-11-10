import { resend } from "@sanoma-ai/connector-resend";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collection } from "../src/collection.ts";
import { defineWorkflow, errorCode } from "../src/index.ts";
import { pageRuntime } from "../src/page-run.ts";
import type { World } from "../src/scenario.ts";

const DAY = 86_400_000;

const invoices = collection({
  name: "invoices",
  key: "number",
  fields: { number: "text", customer: "text", status: { enum: ["sent", "paid", "overdue"] } },
});

/** Sends an invoice, waits a week, then asks before marking it overdue and reminding the customer. */
const chase = defineWorkflow({
  name: "chase-invoice",
  trigger: "manual",
  input: z.object({ number: z.string() }),
  uses: [invoices.get, invoices.save, resend.emails.send, "sleep", "approval"],
  run: async (ctx, { number }) => {
    const found = await ctx.data.invoices.get({ key: number });
    if (!found) throw new Error(`No invoice ${number}`);
    const sentAt = await ctx.now();
    await ctx.resend.emails.send({
      to: found.record.customer,
      from: "Acme <billing@acme.example>",
      subject: `Invoice ${number}`,
      text: "Your invoice is attached.",
    });
    await ctx.sleep({ days: 7 }, { name: "Wait a week" });
    const remindedAt = await ctx.now();
    await ctx.approval("Send a reminder", { approver: "owner" });
    await ctx.data.invoices.save({ record: { ...found.record, status: "overdue" } });
    return { waitedMs: remindedAt - sentAt };
  },
});

const world: World = {
  name: "An invoice sent",
  given: [
    {
      step: 'Given data.invoices "INV-1" has',
      op: "data.invoices.save",
      input: { record: { number: "INV-1", customer: "ada@example.com", status: "sent" } },
    },
  ],
};

const page = (decide?: () => "approve" | "reject") =>
  pageRuntime({
    workflows: [chase],
    collections: [invoices],
    connectors: [resend],
    world,
    ...(decide && { decide }),
  });

describe("pageRuntime", () => {
  it("runs a workflow in memory: a collection read and written, a fake's send, a week's sleep on the run's clock, an approval", async () => {
    const { transport } = await page();
    const { runId } = (await transport({ name: "chaseInvoice", input: { number: "INV-1" }, id: "r1" })) as {
      runId: string;
    };
    expect(runId).toBe("r1");
    // The run's clock moved a week on, and no test waited for it.
    expect(await transport({ name: "chaseInvoice.result", input: { runId } })).toEqual({ waitedMs: 7 * DAY });
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "overdue" },
    });

    const records = (await transport({ name: "chaseInvoice.ledger", input: { runId } })) as {
      type: string;
      at: number;
      op?: string;
      output?: unknown;
      until?: number;
      decision?: unknown;
    }[];
    expect(records.map((r) => (r.op ? `${r.type} ${r.op}` : r.type))).toEqual([
      "run.started",
      "op.called data.invoices.get",
      "op.called resend.emails.send",
      "sleep.started",
      "approval.requested",
      "approval.decided",
      "op.called data.invoices.save",
      "run.finished",
    ]);
    const sleep = records.find((r) => r.type === "sleep.started")!;
    expect(sleep).toMatchObject({ name: "Wait a week", until: sleep.at + 7 * DAY });
    expect(records.find((r) => r.op === "resend.emails.send")!.output).toEqual({ id: expect.any(String) });
    expect(records.find((r) => r.type === "approval.decided")).toMatchObject({ decision: "approve", by: "owner" });

    expect(await transport({ name: "chaseInvoice.approvals", input: { runId } })).toEqual([
      expect.objectContaining({ title: "Send a reminder", status: "approved", decidedBy: "owner" }),
    ]);
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([
      expect.objectContaining({
        runId,
        workflow: "chase-invoice",
        status: "finished",
        startedBy: { id: "anonymous", groups: [] },
      }),
    ]);
    expect(await transport({ name: "chaseInvoice.latest" })).toMatchObject({ runId, output: { waitedMs: 7 * DAY } });
    // The same id again is the same run.
    expect(await transport({ name: "chaseInvoice.start", input: { number: "INV-1" }, id: "r1" })).toEqual({ runId });
  });

  it("fails a run whose approval is rejected, and leaves the record as it was", async () => {
    const { transport } = await page(() => "reject");
    const { runId } = (await transport({ name: "chaseInvoice", input: { number: "INV-1" } })) as { runId: string };
    const failed = await transport({ name: "chaseInvoice.result", input: { runId } }).catch((err: unknown) => err);
    expect(errorCode(failed)).toBe("approval_rejected");
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("rejected") }),
    ]);
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "sent" },
    });
    expect(await transport({ name: "chaseInvoice.latest" })).toBeNull();
  });

  it("starts each run on its own clock", async () => {
    const { transport } = await page();
    const before = Date.now();
    const first = (await transport({ name: "chaseInvoice", input: { number: "INV-1" } })) as { runId: string };
    await transport({ name: "chaseInvoice.result", input: first });
    const second = (await transport({ name: "chaseInvoice", input: { number: "INV-1" } })) as { runId: string };
    await transport({ name: "chaseInvoice.result", input: second });
    const runs = (await transport({ name: "chaseInvoice.runs" })) as { runId: string; createdAt: number }[];
    expect(runs.map((r) => r.runId)).toEqual([second.runId, first.runId]);
    // Each run started at the page's time, not where the run before it left its clock.
    for (const run of runs) expect(run.createdAt).toBeLessThan(before + DAY);
  });

  it("goes back to the seeded world on reset", async () => {
    const { transport, reset } = await page();
    const { runId } = (await transport({ name: "chaseInvoice", input: { number: "INV-1" } })) as { runId: string };
    await transport({ name: "chaseInvoice.result", input: { runId } });
    await transport({
      name: "data.invoices.save",
      input: { record: { number: "INV-2", customer: "bo@example.com", status: "sent" } },
    });

    await reset();
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "sent" },
    });
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-2" } })).toBeNull();
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([]);
    await expect(transport({ name: "chaseInvoice.result", input: { runId } })).rejects.toThrow(/No run/);
  });

  it("refuses a vendor's send called directly, a name it does not run, and a workflow whose operation has no fake", async () => {
    const { transport } = await page();
    await expect(
      transport({ name: "resend.emails.send", input: { to: "a@b.c", from: "a@b.c", subject: "s", text: "t" } }),
    ).rejects.toThrow(/cannot be called directly/);
    await expect(transport({ name: "nothing" })).rejects.toThrow(/no operation or workflow/);
    await expect(pageRuntime({ workflows: [chase], collections: [invoices] })).rejects.toThrow(
      /uses resend\.emails\.send, but no fake/,
    );
  });

  it("refuses a world its fakes cannot take", async () => {
    await expect(
      pageRuntime({
        workflows: [],
        world: { name: "A ghost post", given: [{ step: "Given a ghost post", op: "ghost.post.create", input: {} }] },
      }),
    ).rejects.toThrow(
      /Scenario "A ghost post" seeds ghost\.post\.create, but no fake its connectors attach implements it/,
    );
  });
});
