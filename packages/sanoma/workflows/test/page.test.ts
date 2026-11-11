import { resend } from "@sanoma-ai/connector-resend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { collection } from "../src/collection.ts";
import { defineWorkflow, errorCode } from "../src/index.ts";
import { type PageRuntime, type PageRuntimeOptions, pageRuntime } from "../src/page-run.ts";
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
    await ctx.resend.emails.send(
      {
        to: found.record.customer,
        from: "Acme <billing@acme.example>",
        subject: `Invoice ${number}`,
        text: "Your invoice is attached.",
      },
      { name: "Email the invoice" },
    );
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

const page = (decide?: PageRuntimeOptions["decide"]) =>
  pageRuntime({
    workflows: [chase],
    collections: [invoices],
    connectors: [resend],
    world,
    ...(decide && { decide }),
  });

/** The records' types and operations, as a run card reads them. */
type Read = {
  type: string;
  at: number;
  name?: string;
  op?: string;
  output?: unknown;
  until?: number;
  decision?: unknown;
};

/** A run started in the page, then the page's pending work done (no time passing): its id. */
const begin = async (transport: PageRuntime["transport"]) => {
  const { runId } = (await transport({ name: "chaseInvoice", input: { number: "INV-1" } })) as { runId: string };
  await vi.advanceTimersByTimeAsync(0);
  return runId;
};

/** The run's records. */
const ledger = async (transport: PageRuntime["transport"], runId: string) =>
  (await transport({ name: "chaseInvoice.ledger", input: { runId } })) as Read[];

/** The records, as `type` or `type op`. */
const stepsOf = (records: Read[]) => records.map((r) => (r.op ? `${r.type} ${r.op}` : r.type));

/** The run's records, as `type` or `type op`. */
const steps = async (transport: PageRuntime["transport"], runId: string) => stepsOf(await ledger(transport, runId));

/** Where `chase` rests: the invoice read and emailed, the week's sleep begun. */
const RESTING = ["run.started", "op.called data.invoices.get", "op.called resend.emails.send", "sleep.started"];

describe("pageRuntime", () => {
  // A sleep waits on the page's timers, faked here so a week passes when a test says.
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("rests a run at its sleep, as the app's does: running, nothing after it done, until its time comes", async () => {
    const { transport } = await page();
    const runId = await begin(transport);
    expect(await steps(transport, runId)).toEqual(RESTING);
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([
      expect.objectContaining({ runId, status: "running" }),
    ]);
    expect(await transport({ name: "chaseInvoice.approvals", input: { runId } })).toEqual([]);
    expect(await transport({ name: "chaseInvoice.latest" })).toBeNull();
    const running = transport({ name: "chaseInvoice.result", input: { runId, waitMs: 10 } }).catch((err) => err);
    await vi.advanceTimersByTimeAsync(10);
    expect(errorCode(await running)).toBe("run_running");
    expect(await running).toMatchObject({ data: { runId } });

    // A day short of the week, it still rests; at the week, it goes on.
    await vi.advanceTimersByTimeAsync(6 * DAY);
    expect(await steps(transport, runId)).toEqual(RESTING);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(await transport({ name: "chaseInvoice.result", input: { runId } })).toEqual({ waitedMs: 7 * DAY });
  });

  it("waits a sleep longer than a timer takes", async () => {
    const month = defineWorkflow({
      name: "month",
      trigger: "manual",
      input: z.object({}),
      uses: ["sleep"],
      run: async (ctx) => {
        await ctx.sleep({ days: 30 });
        return "woke";
      },
    });
    const { transport } = await pageRuntime({ workflows: [month] });
    const { runId } = (await transport({ name: "month", input: {} })) as { runId: string };
    await vi.advanceTimersByTimeAsync(29 * DAY);
    expect(await transport({ name: "month.runs" })).toEqual([expect.objectContaining({ status: "running" })]);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(await transport({ name: "month.result", input: { runId } })).toBe("woke");
  });

  it("runs a workflow in memory: a collection read and written, a fake's send, a week's sleep, an approval", async () => {
    const { transport } = await page();
    const { runId } = (await transport({ name: "chaseInvoice", input: { number: "INV-1" }, id: "r1" })) as {
      runId: string;
    };
    expect(runId).toBe("r1");
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(await transport({ name: "chaseInvoice.result", input: { runId } })).toEqual({ waitedMs: 7 * DAY });
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "overdue" },
    });

    const records = await ledger(transport, runId);
    expect(stepsOf(records)).toEqual([
      ...RESTING,
      "approval.requested",
      "approval.decided",
      "op.called data.invoices.save",
      "run.finished",
    ]);
    const sleep = records.find((r) => r.type === "sleep.started")!;
    expect(sleep).toMatchObject({ name: "Wait a week", until: sleep.at + 7 * DAY });
    // The records after the sleep are written when it ends.
    expect(records.find((r) => r.type === "approval.requested")!.at).toBe(sleep.until);
    // Each call under the name it gives, as a worker records it from the outline; one that gives none under its operation.
    expect(records.filter((r) => r.op).map((r) => r.name)).toEqual([
      "data.invoices.get",
      "Email the invoice",
      "data.invoices.save",
    ]);
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
    const runId = await begin(transport);
    const failed = transport({ name: "chaseInvoice.result", input: { runId } }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(errorCode(await failed)).toBe("approval_rejected");
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("rejected") }),
    ]);
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "sent" },
    });
    expect(await transport({ name: "chaseInvoice.latest" })).toBeNull();
  });

  it("goes back to the seeded world on reset, a sleeping run dropped with its timer", async () => {
    const decide = vi.fn<() => "approve">(() => "approve");
    const { transport, reset } = await page(decide);
    const runId = await begin(transport);
    const result = transport({ name: "chaseInvoice.result", input: { runId } }).catch((err: unknown) => err);
    await transport({
      name: "data.invoices.save",
      input: { record: { number: "INV-2", customer: "bo@example.com", status: "sent" } },
    });
    expect(vi.getTimerCount()).toBe(1);

    await reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(errorCode(await result)).toBe("run_ended");
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(decide).not.toHaveBeenCalled();
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "sent" },
    });
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-2" } })).toBeNull();
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([]);
    await expect(transport({ name: "chaseInvoice.result", input: { runId } })).rejects.toThrow(/No run/);
    // A run after the reset runs.
    expect(await steps(transport, await begin(transport))).toEqual(RESTING);
  });

  it("drops its runs on stop, a sleeping one's timer with it, and runs none after", async () => {
    const decide = vi.fn<() => "approve">(() => "approve");
    const { transport, stop } = await page(decide);
    const runId = await begin(transport);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(decide).not.toHaveBeenCalled();
    expect(await steps(transport, runId)).toEqual([...RESTING, "run.failed"]);
    // One started after it stops at its first call, before it reads anything.
    const after = await begin(transport);
    expect(await steps(transport, after)).toEqual(["run.started"]);
    expect(await transport({ name: "data.invoices.get", input: { key: "INV-1" } })).toMatchObject({
      record: { status: "sent" },
    });
  });

  it("halts a dropped run that catches the drop, rather than letting it spin on calls that fail", async () => {
    let caught = 0;
    const retry = defineWorkflow({
      name: "retry",
      trigger: "manual",
      input: z.object({}),
      uses: ["sleep"],
      run: async (ctx) => {
        for (let i = 0; i < 1000; i++) {
          try {
            await ctx.sleep({ hours: 1 });
          } catch {
            caught++;
          }
        }
      },
    });
    const { transport, stop } = await pageRuntime({ workflows: [retry] });
    await transport({ name: "retry", input: {} });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(caught).toBe(1);
    expect(await transport({ name: "retry.runs" })).toEqual([expect.objectContaining({ status: "running" })]);
  });

  it("reads waiting while an approval is pending, as the app does, and goes on once it is decided", async () => {
    const decision = Promise.withResolvers<"approve">();
    const { transport } = await page(() => decision.promise);
    const runId = await begin(transport);
    await vi.advanceTimersByTimeAsync(7 * DAY);
    expect(await transport({ name: "chaseInvoice.runs" })).toEqual([expect.objectContaining({ status: "waiting" })]);
    decision.resolve("approve");
    expect(await transport({ name: "chaseInvoice.result", input: { runId } })).toEqual({ waitedMs: 7 * DAY });
  });

  it("refuses a vendor's send called directly, a name it does not run, a start it cannot make, and a workflow whose operation has no fake", async () => {
    const { transport } = await page();
    await expect(
      transport({ name: "resend.emails.send", input: { to: "a@b.c", from: "a@b.c", subject: "s", text: "t" } }),
    ).rejects.toThrow(/cannot be called directly/);
    await expect(transport({ name: "nothing" })).rejects.toThrow(/no operation or workflow/);
    // A start checks its input before there is a run, and an id names one run.
    await expect(transport({ name: "chaseInvoice", input: {} })).rejects.toThrow(
      /does not match chase-invoice's schema/,
    );
    await transport({ name: "chaseInvoice", input: { number: "INV-1" }, id: "once" });
    await expect(transport({ name: "chaseInvoice", input: { number: "INV-2" }, id: "once" })).rejects.toThrow(
      /was started as another run/,
    );
    await expect(transport({ name: "chaseInvoice", input: { number: "INV-1" }, id: "page:1" })).rejects.toThrow(
      /An id is letters/,
    );
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
