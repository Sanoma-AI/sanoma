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
  save: vi.fn<(input: { record: Record<string, unknown> }) => Promise<Saved>>(),
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
  const subscription = view.collection.subscribeChanges(() => {});
  return { queryClient, subscription, ...view };
}

/** A change of `key`'s stage, as the collection's own update makes it. */
const setStage = ({ collection }: ReturnType<typeof viewOf>, key: string, stage: string) =>
  collection.update(key, (draft) => {
    draft.record = { ...draft.record, stage };
  });

const HELD = new ApiError(409, { error: "Held for approval", code: "approval_pending", runId: "call:ada:1" });
const DENIED = new ApiError(403, { error: "leads are not lost", code: "policy_denied" });

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

  it("lets a view go once nothing shows it, query and all, and makes it again for the search", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { queryClient, subscription, ...view } = viewOf(row("Acme", {}));
    subscription.unsubscribe();
    // Its 10 s, and the moment the library takes to start counting them.
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    expect(view.collection.status).toBe("cleaned-up");
    expect(queryClient.getQueryData(["data", "leads", QUERY])).toBeUndefined();
    // Read again, as the page reads a search it has not kept.
    list.mockResolvedValueOnce([row("Acme", { stage: "new" })]);
    const again = recordsView(queryClient, sourceOf(QUERY));
    expect(again.collection).not.toBe(view.collection);
    await vi.waitFor(() => expect(again.collection.get("Acme")?.record.stage).toBe("new"));
  });

  it("saves an update over the record it found (ifRecord), and keeps what the save answered", async () => {
    const view = viewOf(row("Acme", { stage: "new" }));
    const { collection } = view;
    calls.save.mockImplementationOnce(savedBy);
    const tx = setStage(view, "Acme", "replied");
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

  it("saves an edit over the record as stored when the one before it was held, and never waits on another record's", async () => {
    const { collection, edit } = viewOf(row("Acme", { stage: "new" }), row("Gizmo", { stage: "new" }));
    let hold!: () => void;
    calls.save.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          hold = () => reject(HELD);
        }),
    );
    const first = edit({ key: "Acme", record: { company: "Acme", stage: "won" } });
    const second = edit({ key: "Acme", record: { company: "Acme", stage: "won", contact: "a@acme.test" } });
    // Gizmo's edit is saved while Acme's first still waits for its answer.
    calls.save.mockImplementationOnce(savedBy);
    const other = edit({ key: "Gizmo", record: { company: "Gizmo", stage: "replied" } });
    await other.when("settled");
    expect(calls.save.mock.calls.map(([input]) => input.record.company)).toEqual(["Acme", "Gizmo"]);
    calls.save.mockImplementationOnce(savedBy);
    hold();
    await Promise.all([first.when("settled"), second.when("settled")]);
    // Over the record as stored, not the held change still on screen when it was made.
    expect(calls.save.mock.calls[2]![0]).toEqual({
      record: { company: "Acme", stage: "won", contact: "a@acme.test" },
      ifRecord: { company: "Acme", stage: "new" },
    });
    expect(collection.get("Gizmo")?.record.stage).toBe("replied");
  });

  it("rolls the edits made on a refused one back with it, and saves the next edit after them", async () => {
    const { collection, edit } = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockRejectedValueOnce(DENIED);
    const first = edit({ key: "Acme", record: { company: "Acme", stage: "lost" } });
    const second = edit({ key: "Acme", record: { company: "Acme", stage: "lost", contact: "a@acme.test" } });
    await expect(first.when("settled")).rejects.toBe(DENIED);
    await expect(second.when("settled")).rejects.toBeUndefined();
    expect(collection.get("Acme")?.record).toEqual({ company: "Acme", stage: "new" });
    calls.save.mockImplementationOnce(savedBy);
    await edit({ key: "Acme", record: { company: "Acme", stage: "replied" } }).when("settled");
    expect(calls.save).toHaveBeenCalledTimes(2);
    expect(calls.save.mock.calls[1]![0]).toEqual({
      record: { company: "Acme", stage: "replied" },
      ifRecord: { company: "Acme", stage: "new" },
    });
  });

  it("rolls a denied save back, failing with the policy's error", async () => {
    const view = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockRejectedValueOnce(DENIED);
    const tx = setStage(view, "Acme", "lost");
    await expect(tx.when("settled")).rejects.toBe(DENIED);
    expect(view.collection.get("Acme")?.record.stage).toBe("new");
    expect(held).toHaveBeenCalledWith(DENIED, expect.any(QueryClient));
  });

  it("rolls a save over a changed record back, failing with record_changed and the record as it stands", async () => {
    const view = viewOf(row("Acme", { stage: "new" }));
    const current = { ...row("Acme", {}, "cy"), record: { company: "Acme", stage: "meeting" } };
    calls.save.mockRejectedValueOnce(
      new ApiError(409, { error: "Collection record changed or is missing", code: "record_changed", current }),
    );
    const err = await setStage(view, "Acme", "replied")
      .when("settled")
      .catch((e: unknown) => e);
    expect(errorBodyOf(err)).toMatchObject({ code: "record_changed", current });
    expect(view.collection.get("Acme")?.record.stage).toBe("new");
  });

  it("resolves a save held for an approval, showing the record as stored until the run ends", async () => {
    const view = viewOf(row("Acme", { stage: "new" }));
    calls.save.mockRejectedValueOnce(HELD);
    const tx = setStage(view, "Acme", "won");
    await expect(tx.when("settled")).resolves.toBe(tx);
    expect(savedIn(tx, "Acme")).toBeUndefined();
    expect(held).toHaveBeenCalledWith(HELD, view.queryClient);
    expect(view.collection.get("Acme")?.record.stage).toBe("new");
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
