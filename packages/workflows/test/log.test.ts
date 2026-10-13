import { describe, expect, it, vi } from "vitest";
import { dbosLogger, quietIfSandbox } from "../src/log.ts";

// DBOS's GlobalLogger hands `dbosLogger` a string, with the stack and the error in the metadata.
const failed = (error: Error) => dbosLogger.error(error.message, { stack: error.stack, error });

describe("dbosLogger", () => {
  it("drops DBOS's warnings from inside a sandbox run, whatever they say, and shows a live run's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await quietIfSandbox(true, async () => dbosLogger.warn("Step retry predicate failed. Attempt 1 of 3."));
    expect(warn).not.toHaveBeenCalled();
    await quietIfSandbox(false, async () => dbosLogger.warn("Error in step being automatically retried."));
    expect(warn).toHaveBeenCalledWith("Error in step being automatically retried.");
  });

  it("drops the error a sandbox run fails with, and shows a live run failing with the same error object", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // One instance, as a module-level error a fake and a driver might both throw.
    const shared = Object.assign(new Error("the vendor said no"), { code: "driver_failed" });
    const thrown = await quietIfSandbox(true, () => Promise.reject(shared)).catch((e: unknown) => e as Error);
    // The run fails with a copy made for it, of the same class, message, properties and stack.
    expect(thrown).not.toBe(shared);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ message: "the vendor said no", code: "driver_failed", stack: shared.stack });
    failed(thrown);
    expect(error).not.toHaveBeenCalled();

    const live = await quietIfSandbox(false, () => Promise.reject(shared)).catch((e: unknown) => e as Error);
    expect(live).toBe(shared);
    failed(live);
    expect(error).toHaveBeenCalledWith("the vendor said no", "\n", shared.stack);
  });
});
