import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineWorkflow } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

/** Defines a workflow on `trigger`, when called. */
const at = (trigger: unknown) => () => defineWorkflow({ ...announce, name: "timed", trigger: trigger as never });

describe("defineWorkflow", () => {
  it("records the file that called it", () => {
    expect(announce.file).toBe(fileURLToPath(new URL("./fixtures/announce.ts", import.meta.url)));
    expect(defineWorkflow({ ...announce, name: "here" }).file).toBe(fileURLToPath(import.meta.url));
  });

  it("refuses a definition from code with no file, which could not be outlined", () => {
    // Code made with the Function constructor has no script name.
    const define = new Function("defineWorkflow", "def", "return defineWorkflow(def)") as (
      d: typeof defineWorkflow,
      def: unknown,
    ) => unknown;
    expect(() => define(defineWorkflow, { ...announce, name: "nowhere" })).toThrow(
      /^Workflow "nowhere" was defined from code with no file .*: its outline is read from the file/,
    );
  });

  it("takes a schedule as its trigger: five cron fields, in an IANA time zone when it names one", () => {
    expect(at({ schedule: "0 9 * * 1-5", timezone: "Europe/Amsterdam" })().trigger).toEqual({
      schedule: "0 9 * * 1-5",
      timezone: "Europe/Amsterdam",
    });
    expect(at({ schedule: "*/15 * * * *" })().trigger).toEqual({ schedule: "*/15 * * * *" });
    expect(at("hourly")).toThrow('Workflow "timed": its trigger is "manual" or { schedule, timezone? }');
    expect(at({ schedule: "0 0 9 * * *" })).toThrow(
      /its schedule "0 0 9 \* \* \*" is a cron expression of five fields/,
    );
    expect(at({ schedule: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow(
      'Workflow "timed": its timezone "Mars/Olympus" is no IANA time zone, such as "Europe/Amsterdam"',
    );
  });
});
