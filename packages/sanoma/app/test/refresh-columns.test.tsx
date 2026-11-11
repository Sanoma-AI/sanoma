import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configQuery, refreshColumns } from "../src/queries.ts";

// `refreshColumns` after a column change written without a remote: the app answers the
// description it started with, so the page reads it again until the app started again on the new
// one. The server function is scripted: the old fields, none while the app starts, then the new.

const answers: unknown[] = [];
vi.mock("../src/functions.ts", () => ({
  getConfig: vi.fn<() => Promise<unknown>>(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  }),
  getSource: vi.fn<() => Promise<string>>(async () => "source"),
}));

const OLD = { company: "text", seats: "text" } as const;
const NEW = { company: "text", headcount: "text" } as const;
// Only what `refreshColumns` reads of the description.
const configWith = (fields: object) => ({ collections: [{ name: "outbound", fields }] }) as never;

afterEach(() => vi.useRealTimers());

describe("the columns read again after a column change", () => {
  it("waits for the app started again on the new columns, then reads the records again", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    queryClient.setQueryData(configQuery().queryKey, configWith(OLD));
    queryClient.setQueryData(["data", "outbound", { limit: 50 }], []);
    answers.push(configWith(OLD), new Error("The app is starting"), configWith(NEW), configWith(NEW));
    const done = refreshColumns(queryClient, {
      file: "resources/data.ts",
      name: "outbound",
      before: OLD,
      running: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    // The app has not started again yet: the page keeps what it has.
    expect(queryClient.getQueryData(configQuery().queryKey)).toEqual(configWith(OLD));
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(queryClient.getQueryData(configQuery().queryKey)).toEqual(configWith(NEW));
    expect(queryClient.getQueryState(["data", "outbound", { limit: 50 }])?.isInvalidated).toBe(true);
    expect(answers).toEqual([configWith(NEW)]);
  });

  it("reads the description once when the app does not start again", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(configQuery().queryKey, configWith(OLD));
    answers.length = 0;
    await refreshColumns(queryClient, { file: "resources/data.ts", name: "outbound", before: OLD, running: false });
    expect(queryClient.getQueryState(configQuery().queryKey)?.isInvalidated).toBe(true);
  });
});
