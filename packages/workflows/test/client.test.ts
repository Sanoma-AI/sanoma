import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@sanoma/testing";
import { describe, expect, it } from "vitest";
import { runStatus } from "../src/client.ts";
import { type ApprovalState, errorCode, SanomaClient } from "../src/index.ts";
import announce from "./fixtures/announce.ts";
import { inSeconds, pending, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`.
const databaseUrl = testDatabaseUrl("client");
const alice = { id: "alice" };
const lead = { id: "marketing-lead" };
const input = { title: "Client", body: "<p>x</p>", launchAt: inSeconds(1) };

const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

const approval = (status: ApprovalState["status"]) => ({ status }) as ApprovalState;

describe("runStatus", () => {
  it("maps DBOS statuses, and a running run with an approval pending to waiting", () => {
    expect(runStatus("ENQUEUED", [])).toBe("queued");
    expect(runStatus("DELAYED", [])).toBe("queued");
    expect(runStatus("PENDING", [])).toBe("running");
    expect(runStatus("PENDING", [approval("approved")])).toBe("running");
    expect(runStatus("PENDING", [approval("approved"), approval("pending")])).toBe("waiting");
    expect(runStatus("SUCCESS", [])).toBe("finished");
    expect(runStatus("ERROR", [approval("rejected")])).toBe("failed");
    expect(runStatus("MAX_RECOVERY_ATTEMPTS_EXCEEDED", [])).toBe("failed");
    expect(runStatus("CANCELLED", [approval("pending")])).toBe("cancelled");
    expect(runStatus("SOMETHING_NEW", [])).toBe("running");
  });
});

describe("SanomaClient", () => {
  const app = useApp(databaseUrl, "client");
  const c = () => app.client;

  it("refuses input the workflow's schema refuses, with invalid_input and zod's issues, before queueing", async () => {
    const before = (await c().runs(1))[0]?.runId;
    const err = await caught(c().start(announce, { ...input, launchAt: "tomorrow" }, { startedBy: alice }));
    expect(errorCode(err)).toBe("invalid_input");
    expect(err).toMatchObject({
      message: expect.stringMatching(/launchAt/),
      data: { issues: [expect.objectContaining({ path: ["launchAt"], message: expect.any(String) })] },
    });
    expect((await c().runs(1))[0]?.runId).toBe(before);
  });

  it("requires a principal to start a run as", async () => {
    const err = await caught(c().start(announce, input, { startedBy: { id: " " } }));
    expect(errorCode(err)).toBe("invalid_input");
    expect(err).toMatchObject({ data: { issues: [expect.objectContaining({ path: ["id"] })] } });
    const missing = await caught(c().start(announce, input, {} as never));
    expect(errorCode(missing)).toBe("invalid_input");
  });

  it("says run_not_found for a run that does not exist, rather than waiting on it or reading no records", async () => {
    const missing = randomUUID();
    for (const call of [
      () => c().result(missing),
      () => c().ledger(missing),
      () => c().decide(missing, { decision: "approve", by: lead }),
    ]) {
      const err = await caught(call());
      expect(errorCode(err)).toBe("run_not_found");
      expect(err).toMatchObject({ message: `No run ${missing}`, data: { runId: missing } });
    }
    expect(await c().run(missing)).toBeUndefined();
  });

  it("refuses a decision as not_approver, no_pending_approval or already_decided, with no message sent", async () => {
    const runId = await c().start(announce, input, { startedBy: alice });
    await waitFor(pending(c, runId));

    const wrong = await caught(c().decide(runId, { decision: "approve", by: { id: "intern" } }));
    expect(errorCode(wrong)).toBe("not_approver");
    expect(wrong).toMatchObject({ data: { runId, approvalId: "approval-1", approver: "marketing-lead" } });
    const unknown = await caught(c().decide(runId, { decision: "approve", by: lead }, "approval-9"));
    expect(errorCode(unknown)).toBe("no_pending_approval");
    const garbled = await caught(c().decide(runId, { decision: "maybe", by: lead } as never));
    expect(errorCode(garbled)).toBe("invalid_input");
    expect((await c().approvals(runId))[0]).toMatchObject({ status: "pending", refused: [] });

    await c().decide(runId, { decision: "approve", by: lead });
    await waitFor(async () => (await c().approvals(runId))[0]?.status === "approved");
    const again = await caught(c().decide(runId, { decision: "reject", by: lead }, "approval-1"));
    expect(errorCode(again)).toBe("already_decided");
    expect(again).toMatchObject({
      data: { approvalId: "approval-1", status: "approved", decidedBy: "marketing-lead" },
    });

    await c().result(runId);
    const none = await caught(c().decide(runId, { decision: "approve", by: lead }));
    expect(errorCode(none)).toBe("no_pending_approval");
  });

  it("lists the app's runs with their status and who started them", async () => {
    const runId = await c().start(announce, input, { startedBy: { id: "bob", groups: ["ops", "marketing"] } });
    await waitFor(pending(c, runId));
    const [listed] = (await c().runs(50)).filter((r) => r.runId === runId);
    expect(listed).toMatchObject({
      workflow: "announce",
      status: "waiting",
      startedBy: { id: "bob", groups: ["ops", "marketing"] },
      approvals: [expect.objectContaining({ id: "approval-1", status: "pending" })],
    });
    await c().decide(runId, { decision: "approve", by: lead });
    await c().result(runId);
    expect((await c().run(runId))?.status).toBe("finished");
  });

  it("checks the config on connect, the way the worker does", async () => {
    await expect(SanomaClient.connect({ ...app.config, policy: undefined as never })).rejects.toThrow(
      "The config needs a `policy`; use `allowAll` to allow every operation call",
    );
  });
});
