import type { Saved } from "@sanoma-ai/workflows/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError, errorBodyOf } from "../src/api.ts";
import { recordsView, savedIn } from "../src/components/grid/collection.ts";

// The Data page's records collection (`components/grid/collection.ts`) over a fake `api`: each
// change's handler makes the one call, with `ifRecord` the record as the change found it, and
// answers as the grid and the record form read it. No browser, no server: the calls, the query
// and the held call's toast are fakes, as the page hands it its own.

const calls = {
  save: vi.fn<(input: { record: Record<string, unknown> }) => Promise<unknown>>(),
  delete: vi.fn<(input: { key: string }) => Promise<unknown>>(),
};
const list = vi.fn<() => Promise<Saved[]>>();
/** Says a call is held as `toastIfHeld` does: what it was told, and whether it was. */
const held = vi.fn<(err: unknown) => boolean>((err) => errorBodyOf(err)?.code === "approval_pending");

const QUERY = { limit: 100 };
const row = (key: string, record: Record<string, unknown>, updatedBy = "bo"): Saved => ({
  key,
  record: { company: key, ...record },
  updatedAt: "2026-11-04T10:00:00.000Z",
  updatedBy,
});

/** What the page hands the collection for `query`: `recordsQuery`'s key and function, and the calls. */
const sourceOf = (query: object) => ({
  query: { queryKey: ["data", "leads", query], queryFn: list, staleTime: 5_000 },
  calls,
  held,
});

/** The page's view of `rows`, as the loader's prefetch leaves them in the query client. */
function viewOf(...rows: Saved[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["data", "leads", QUERY], rows);
  const view = recordsView(queryClient, sourceOf(QUERY));
  // Kept syncing, as a mounted grid keeps it.
  view.collection.subscribeChanges(() => {});
  return { queryClient, ...view };
}

/** What `save` answers for `input`: the record as saved, by ada. */
const savedBy = (input: { record: Record<string, unknown> }): Promise<Saved> =>
  Promise.resolve({ ...row(String(input.record.company), {}), record: input.record, updatedBy: "ada" });

describe("the Data page's records collection", () => {
  it("starts with the rows the loader read, and is one per query client and search", () => {
    const { queryClient, collection } = viewOf(row("Acme", { stage: "new" }));
    expect(collection.get("Acme")?.record).toEqual({ company: "Acme", stage: "new" });
    expect(list).not.toHaveBeenCalled();
    expect(recordsView(queryClient, sourceOf({ limit: 100 })).collection).toBe(collection);
    expect(recordsView(queryClient, sourceOf({ limit: 25 })).collection).not.toBe(collection);
    expect(recordsView(new QueryClient(), sourceOf(QUERY)).collection).not.toBe(collection);
  });

  it("saves an update over the record it found (ifRecord), and keeps what the save answered", async () => {
    const { collection } = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockImplementationOnce(savedBy);
    const tx = collection.update("Acme", (draft) => {
      draft.record = { ...draft.record, stage: "replied" };
    });
    // At once, before the call answers.
    expect(collection.get("Acme")?.record.stage).toBe("replied");
    await tx.when("settled");
    expect(calls.save).toHaveBeenCalledWith({
      record: { company: "Acme", stage: "replied" },
      ifRecord: { company: "Acme", stage: "new" },
    });
    expect(savedIn(tx, "Acme")).toMatchObject({ record: { stage: "replied" }, updatedBy: "ada" });
    expect(collection.get("Acme")).toMatchObject({ record: { stage: "replied" }, updatedBy: "ada" });
  });

  it("saves the grid's edits one after another, each over the record the one before saved", async () => {
    const { collection, edit } = viewOf(row("Acme", { stage: "new" }));
    let answer!: () => void;
    calls.save.mockImplementationOnce(
      (input: { record: Record<string, unknown> }) =>
        new Promise((resolve) => (answer = () => resolve(savedBy(input)))),
    );
    calls.save.mockImplementationOnce(savedBy);
    const first = edit({ key: "Acme", record: { company: "Acme", stage: "replied" } });
    const second = edit({ key: "Acme", record: { company: "Acme", stage: "replied", contact: "a@acme.test" } });
    await vi.waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
    answer();
    await Promise.all([first.when("settled"), second.when("settled")]);
    expect(calls.save.mock.calls[1]![0]).toEqual({
      record: { company: "Acme", stage: "replied", contact: "a@acme.test" },
      ifRecord: { company: "Acme", stage: "replied" },
    });
    expect(collection.get("Acme")?.record).toEqual({ company: "Acme", stage: "replied", contact: "a@acme.test" });
  });

  it("rolls a denied save back, failing with the policy's error", async () => {
    const { collection } = viewOf(row("Acme", { stage: "new" }));
    const denied = new ApiError(403, { error: "leads are not lost", code: "policy_denied" });
    calls.save.mockRejectedValueOnce(denied);
    const tx = collection.update("Acme", (draft) => {
      draft.record = { ...draft.record, stage: "lost" };
    });
    await expect(tx.when("settled")).rejects.toBe(denied);
    expect(collection.get("Acme")?.record.stage).toBe("new");
    expect(held).toHaveBeenCalledWith(denied, expect.any(QueryClient));
  });

  it("rolls a save over a changed record back, failing with record_changed and the record as it stands", async () => {
    const { collection } = viewOf(row("Acme", { stage: "new" }));
    const current = { ...row("Acme", {}, "cy"), record: { company: "Acme", stage: "meeting" } };
    calls.save.mockRejectedValueOnce(
      new ApiError(409, { error: "Collection record changed or is missing", code: "record_changed", current }),
    );
    const tx = collection.update("Acme", (draft) => {
      draft.record = { ...draft.record, stage: "replied" };
    });
    const err = await tx.when("settled").catch((e: unknown) => e);
    expect(errorBodyOf(err)).toMatchObject({ code: "record_changed", current });
    expect(collection.get("Acme")?.record.stage).toBe("new");
  });

  it("resolves a save held for an approval, showing the record as stored until the run ends", async () => {
    const { queryClient, collection } = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockRejectedValueOnce(
      new ApiError(409, { error: "Held for approval", code: "approval_pending", runId: "call:ada:1" }),
    );
    const tx = collection.update("Acme", (draft) => {
      draft.record = { ...draft.record, stage: "won" };
    });
    await expect(tx.when("settled")).resolves.toBe(tx);
    expect(savedIn(tx, "Acme")).toBeUndefined();
    expect(held).toHaveBeenCalledWith(expect.any(ApiError), queryClient);
    expect(collection.get("Acme")?.record.stage).toBe("new");
  });

  it("adds a record only where none is (ifAbsent), and deletes one", async () => {
    const { collection } = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockImplementationOnce(savedBy);
    const added = collection.insert(row("Hooli", { stage: "new" }, "ada"));
    await added.when("settled");
    expect(calls.save).toHaveBeenCalledWith({ record: { company: "Hooli", stage: "new" }, ifAbsent: true });
    expect(savedIn(added, "Hooli")).toMatchObject({ key: "Hooli", updatedBy: "ada" });

    calls.delete.mockResolvedValueOnce({ deleted: true });
    const deleted = collection.delete("Acme");
    await deleted.when("settled");
    expect(calls.delete).toHaveBeenCalledWith({ key: "Acme" });
    expect(savedIn(deleted, "Acme")).toBeNull();
    expect(collection.has("Acme")).toBe(false);
    expect(collection.has("Hooli")).toBe(true);
  });
});
