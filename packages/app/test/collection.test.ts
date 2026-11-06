import type { Saved } from "@sanoma-ai/workflows/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError, errorBodyOf } from "../src/api.ts";
import { isNew, type ManyAnswer, newKey, recordsView, savedIn, type Step } from "../src/components/grid/collection.ts";

// The Data page's records collection (`components/grid/collection.ts`) over a fake `api`: each
// change's handler makes the one call, with `ifRecord` the record as the change found it, and
// answers as the grid and the record form read it; a staged change's steps are one transaction,
// saved as one `saveMany`. No browser, no server: the calls, the query and the held call's toast
// are fakes, as the page hands it its own.

type SaveMany = (input: {
  records: { record: Record<string, unknown>; ifRecord?: Record<string, unknown> }[];
  deletes?: { key: string; ifRecord?: Record<string, unknown> }[];
}) => Promise<ManyAnswer[]>;
const calls = {
  save: vi.fn<(input: { record: Record<string, unknown> }) => Promise<Saved>>(),
  delete: vi.fn<(input: { key: string }) => Promise<unknown>>(),
  saveMany: vi.fn<SaveMany>(),
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
  key: "company",
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

    calls.delete.mockResolvedValueOnce({ key: "Acme", deleted: true });
    const deleted = collection.delete("Acme");
    await deleted.when("settled");
    expect(calls.delete).toHaveBeenCalledWith({ key: "Acme" });
    expect(savedIn(deleted, "Acme")).toBeNull();
    expect(collection.has("Acme")).toBe(false);
    expect(collection.has("Hooli")).toBe(true);
  });
});

/** What `saveMany` answers for `input`, as the runtime does: each record saved by ada, each delete at its place. */
const savedManyBy: SaveMany = (input) =>
  Promise.resolve([
    ...input.records.map(({ record }) => ({ ...row(String(record.company), {}), record, updatedBy: "ada" })),
    ...(input.deletes ?? []).map(({ key }) => ({ key, deleted: true })),
  ]);

/** A cell's change, for a step. */
const cell = (key: string, field: string, value: unknown) => ({ key, field, value });

describe("a staged change of the Data page's records", () => {
  const ACME = row("Acme", { stage: "new" });
  const GLOBEX = row("Globex", { stage: "contacted" });
  const GIZMO = row("Gizmo", { stage: "meeting" });

  /** The view over Acme, Globex and Gizmo, which Save's read finds as they were unless told. */
  function staged(...stored: Saved[]) {
    const view = viewOf(ACME, GLOBEX, GIZMO);
    list.mockResolvedValue(stored.length ? stored : [ACME, GLOBEX, GIZMO]);
    return view;
  }
  const paste: Step = {
    what: "paste",
    said: "Pasted 2 rows × 1 column at row 1, stage",
    cells: [cell("Acme", "stage", "replied"), cell("Globex", "stage", "won")],
  };

  it("shows its steps at once, saves nothing until Save, then saves them all in one saveMany, in order", async () => {
    const { collection, stage } = staged();
    const added = newKey();
    stage.add(paste);
    stage.add({ what: "new record", said: "Added a record", adds: [added] });
    stage.add({ what: "edit", said: "Changed company", cells: [cell(added, "company", "Hooli")] });
    stage.add({ what: "delete", said: "Deleted 1 record", deletes: ["Gizmo"] });
    expect(collection.get("Acme")?.record.stage).toBe("replied");
    expect(collection.get(added)?.record).toEqual({ company: "Hooli" });
    // A delete stays on screen, struck, until it is saved.
    expect(collection.has("Gizmo")).toBe(true);
    expect(stage.current()?.tx.mutations.map((m) => [m.key, m.type])).toEqual([
      ["Acme", "update"],
      ["Globex", "update"],
      [added, "insert"],
      ["Gizmo", "delete"],
    ]);
    expect(calls.saveMany).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();

    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save()).resolves.toEqual({ saved: 4 });
    expect(calls.saveMany).toHaveBeenCalledTimes(1);
    expect(calls.saveMany).toHaveBeenCalledWith({
      records: [
        { record: { company: "Acme", stage: "replied" }, ifRecord: ACME.record },
        { record: { company: "Globex", stage: "won" }, ifRecord: GLOBEX.record },
        { record: { company: "Hooli" }, ifAbsent: true },
      ],
      deletes: [{ key: "Gizmo", ifRecord: GIZMO.record }],
    });
    expect(stage.current()).toBeUndefined();
    expect(collection.get("Acme")).toMatchObject({ record: { stage: "replied" }, updatedBy: "ada" });
    expect(collection.get("Hooli")).toMatchObject({ record: { company: "Hooli" }, updatedBy: "ada" });
    expect(collection.has(added)).toBe(false);
    expect(collection.has("Gizmo")).toBe(false);
  });

  it("takes back the last step, and discards them all", () => {
    const { collection, stage } = staged();
    stage.add(paste);
    stage.add({ what: "edit", said: "Changed contact", cells: [cell("Acme", "contact", "a@acme.test")] });
    stage.undo();
    expect(collection.get("Acme")?.record).toEqual({ company: "Acme", stage: "replied" });
    expect(stage.current()?.steps).toEqual([paste]);
    stage.discard();
    expect(stage.current()).toBeUndefined();
    expect(collection.get("Acme")?.record).toEqual(ACME.record);
    expect(collection.get("Globex")?.record).toEqual(GLOBEX.record);
  });

  it("refuses a step that takes the change past what one saveMany saves, keeping the change as it was", () => {
    const { stage } = staged();
    stage.add(paste);
    const adds = Array.from({ length: 999 }, () => newKey());
    expect(() => stage.add({ what: "paste", said: "Pasted 999 rows", adds })).toThrow(/at most 1000 records/);
    expect(stage.current()?.steps).toEqual([paste]);
  });

  it("lets a record gone since take its edits with it: a change over it alone closes", async () => {
    const { collection, stage } = staged();
    stage.add({ what: "edit", said: "Changed stage of Acme", cells: [cell("Acme", "stage", "won")] });
    calls.saveMany.mockRejectedValueOnce(
      new ApiError(409, { error: "Changed", code: "record_changed", conflicts: [{ key: "Acme", current: null }] }),
    );
    await expect(stage.save()).resolves.toEqual({ conflicts: [{ key: "Acme", current: null }] });
    expect(stage.current()).toBeUndefined();
    expect(collection.has("Acme")).toBe(false);
  });

  it("rolls the whole change back when saveMany fails: nothing changed", async () => {
    const { collection, stage } = staged();
    stage.add(paste);
    const failure = new Error("The network is down");
    calls.saveMany.mockRejectedValueOnce(failure);
    await expect(stage.save()).rejects.toBe(failure);
    expect(stage.current()).toBeUndefined();
    expect(collection.get("Acme")?.record).toEqual(ACME.record);
    expect(collection.get("Globex")?.record).toEqual(GLOBEX.record);
  });

  it("drops the records the policy denied, a new one by the key typed into it, and keeps the rest staged", async () => {
    const { collection, stage } = staged();
    const added = newKey();
    stage.add(paste);
    stage.add({ what: "new record", said: "Added a record", adds: [added], cells: [cell(added, "company", "Hooli")] });
    calls.saveMany.mockRejectedValueOnce(
      new ApiError(403, { error: "leads are not won", code: "policy_denied", denied: ["Globex", "Hooli"] }),
    );
    const outcome = await stage.save();
    expect(outcome).toMatchObject({ denied: ["Globex", "Hooli"] });
    expect(collection.has(added)).toBe(false);
    expect(collection.get("Globex")?.record).toEqual(GLOBEX.record);
    expect(collection.get("Acme")?.record.stage).toBe("replied");
    expect(stage.current()?.tx.mutations.map((m) => m.key)).toEqual(["Acme"]);
  });

  it("keeps the change through a conflict, the record as it stands now, and saves over it once settled", async () => {
    const { collection, stage, queryClient } = staged();
    stage.add(paste);
    const current = {
      ...row("Acme", {}, "cy"),
      record: { company: "Acme", stage: "meeting" },
      updatedAt: "2026-11-04T11:00:00.000Z",
    };
    calls.saveMany.mockRejectedValueOnce(
      new ApiError(409, { error: "Changed", code: "record_changed", conflicts: [{ key: "Acme", current }] }),
    );
    await expect(stage.save()).resolves.toEqual({ conflicts: [{ key: "Acme", current }] });
    // Nothing saved, everything still staged, over the record as it stands now.
    expect(stage.current()?.tx.mutations.map((m) => m.key)).toEqual(["Acme", "Globex"]);
    expect(collection.get("Acme")?.record.stage).toBe("replied");
    expect(queryClient.getQueryData<Saved[]>(["data", "leads", QUERY])?.find((r) => r.key === "Acme")).toEqual(current);

    // Use mine: saved over theirs, which Save's read finds as it is.
    stage.rebase("Acme", current);
    list.mockResolvedValue([current, GLOBEX, GIZMO]);
    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save()).resolves.toEqual({ saved: 2 });
    expect(calls.saveMany.mock.calls[1]![0].records[0]).toEqual({
      record: { company: "Acme", stage: "replied" },
      ifRecord: current.record,
    });
  });

  it("finds a record changed since it was staged a conflict before it sends anything", async () => {
    const changed = { ...row("Globex", { stage: "lost" }, "bo"), updatedAt: "2026-11-04T12:00:00.000Z" };
    const { collection, stage } = staged(ACME, changed, GIZMO);
    stage.add(paste);
    await expect(stage.save()).resolves.toEqual({ conflicts: [{ key: "Globex", current: changed }] });
    expect(calls.saveMany).not.toHaveBeenCalled();
    expect(stage.current()?.steps).toEqual([paste]);
    // The read does not undo what is staged: the cells still show your change.
    expect(collection.get("Globex")?.record.stage).toBe("won");
    // Keep theirs: the cell's change dropped, the rest still staged.
    stage.drop("Globex", "stage");
    expect(stage.current()?.tx.mutations.map((m) => m.key)).toEqual(["Acme"]);
  });

  it("saves a conflict's record, once you keep yours, over theirs: their other fields stay theirs", async () => {
    const theirs = {
      ...row("Globex", { stage: "contacted", contact: "g@globex.test" }, "bo"),
      updatedAt: "2026-11-04T12:00:00.000Z",
    };
    const { collection, stage } = staged(ACME, theirs, GIZMO);
    stage.add(paste);
    await expect(stage.save()).resolves.toEqual({ conflicts: [{ key: "Globex", current: theirs }] });
    // Use mine: the steps made again over theirs.
    stage.rebase("Globex", theirs);
    expect(collection.get("Globex")?.record).toEqual({ company: "Globex", stage: "won", contact: "g@globex.test" });
    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save()).resolves.toEqual({ saved: 2 });
    expect(calls.saveMany.mock.calls[0]![0].records[1]).toEqual({
      record: { company: "Globex", stage: "won", contact: "g@globex.test" },
      ifRecord: theirs.record,
    });
  });

  it("sends no record whose staged change ends where it began", async () => {
    const { stage } = staged();
    stage.add(paste);
    stage.add({ what: "edit", said: "Changed stage of Globex", cells: [cell("Globex", "stage", "contacted")] });
    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save()).resolves.toEqual({ saved: 1 });
    expect(calls.saveMany.mock.calls[0]![0].records.map((r) => r.record.company)).toEqual(["Acme"]);
  });

  it("saves only the records it is told, leaving the rest staged", async () => {
    const { collection, stage } = staged();
    stage.add(paste);
    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save(new Set(["Acme"]))).resolves.toEqual({ saved: 1 });
    expect(calls.saveMany.mock.calls[0]![0].records.map((r) => r.record.company)).toEqual(["Acme"]);
    expect(stage.current()?.tx.mutations.map((m) => m.key)).toEqual(["Globex"]);
    expect(collection.get("Globex")?.record.stage).toBe("won");
    expect(collection.get("Acme")).toMatchObject({ record: { stage: "replied" }, updatedBy: "ada" });
  });

  it("keeps a new record whose key a record off the page has, that record written in, and lists no conflict", async () => {
    const { collection, stage } = staged();
    const added = newKey();
    const step = {
      what: "new record",
      said: "Added a record",
      adds: [added],
      cells: [cell(added, "company", "Hooli")],
    };
    stage.add(step);
    const theirs = { ...row("Hooli", {}, "cy"), record: { company: "Hooli", stage: "won" } };
    calls.saveMany.mockRejectedValueOnce(
      new ApiError(409, { error: "Exists", code: "record_changed", conflicts: [{ key: "Hooli", current: theirs }] }),
    );
    await expect(stage.save()).resolves.toEqual({ conflicts: [] });
    expect(collection.get("Hooli")).toMatchObject(theirs);
    expect(stage.current()?.steps).toEqual([step]);
    expect(collection.get(added)?.record).toEqual({ company: "Hooli" });
  });

  it("keeps the change when its read before Save fails, and sends nothing", async () => {
    const { collection, stage } = staged();
    stage.add(paste);
    const refused = new ApiError(403, { error: "reading leads is denied", code: "policy_denied" });
    list.mockRejectedValueOnce(refused);
    await expect(stage.save()).rejects.toBe(refused);
    expect(calls.saveMany).not.toHaveBeenCalled();
    expect(stage.current()?.steps).toEqual([paste]);
    expect(stage.current()?.tx.state).toBe("pending");
    expect(collection.get("Acme")?.record.stage).toBe("replied");
  });

  it("makes the change again from its steps in order, each once, over the record each was first staged over", async () => {
    const { collection, stage } = staged();
    const added = newKey();
    stage.add(paste);
    stage.add({ what: "new record", said: "Added a record", adds: [added], cells: [cell(added, "company", "Hooli")] });
    stage.add({ what: "edit", said: "Changed stage of Acme", cells: [cell("Acme", "stage", "won")] });
    stage.add({ what: "edit", said: "Changed contact of Gizmo", cells: [cell("Gizmo", "contact", "g@gizmo.test")] });
    // Someone else's save of Acme reaches the collection while it is staged.
    const theirs = { ...row("Acme", { stage: "meeting" }, "cy"), updatedAt: "2026-11-04T11:00:00.000Z" };
    await collection.utils.writeUpsert(theirs);

    stage.undo();
    // The later step over the earlier, the new record once, the step taken back gone.
    expect(collection.get("Acme")?.record.stage).toBe("won");
    expect(collection.toArray.filter((r) => isNew(r.key)).map((r) => r.record)).toEqual([{ company: "Hooli" }]);
    expect(collection.get("Gizmo")?.record).toEqual(GIZMO.record);
    expect(stage.current()?.tx.mutations.map((m) => [m.key, m.type])).toEqual([
      ["Acme", "update"],
      ["Globex", "update"],
      [added, "insert"],
    ]);

    // Acme is still saved over the record it was first staged over: theirs is a conflict.
    list.mockResolvedValue([theirs, GLOBEX, GIZMO]);
    await expect(stage.save()).resolves.toEqual({ conflicts: [{ key: "Acme", current: theirs }] });
    stage.rebase("Acme", theirs);
    calls.saveMany.mockImplementationOnce(savedManyBy);
    await expect(stage.save()).resolves.toEqual({ saved: 3 });
    expect(calls.saveMany.mock.calls[0]![0].records).toEqual([
      { record: { company: "Acme", stage: "won" }, ifRecord: theirs.record },
      { record: { company: "Globex", stage: "won" }, ifRecord: GLOBEX.record },
      { record: { company: "Hooli" }, ifAbsent: true },
    ]);
  });

  it("keeps the change when a single edit of one of its records is refused, which the library rolls back with it", async () => {
    const view = staged();
    const { collection, stage } = view;
    calls.save.mockRejectedValueOnce(new ApiError(403, { error: "leads are not lost", code: "policy_denied" }));
    const single = view.edit({ key: "Acme", record: { company: "Acme", stage: "lost" } });
    stage.add(paste);
    await single.when("settled").catch(() => {});
    await vi.waitFor(() => expect(stage.current()?.tx.state).toBe("pending"));
    expect(stage.current()?.steps).toEqual([paste]);
    expect(collection.get("Acme")?.record.stage).toBe("replied");
    expect(collection.get("Globex")?.record.stage).toBe("won");
  });

  it("resolves a batch held for an approval as sent, the records as stored until its run ends", async () => {
    const { collection, stage, queryClient } = staged();
    stage.add(paste);
    calls.saveMany.mockRejectedValueOnce(HELD);
    await expect(stage.save()).resolves.toEqual({ held: 2, runId: "call:ada:1" });
    expect(held).toHaveBeenCalledWith(HELD, queryClient);
    expect(stage.current()).toBeUndefined();
    expect(collection.get("Acme")?.record).toEqual(ACME.record);
  });
});
