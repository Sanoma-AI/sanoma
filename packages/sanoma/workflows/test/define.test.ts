import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ghost } from "@sanoma-ai/connector-ghost";
import { collection } from "../src/collection.ts";
import { defineOperation, defineWorkflow, isOperation } from "../src/index.ts";
import announce from "./fixtures/announce.ts";

/** Defines a workflow on `trigger` whose input is `input` (none by default), when called. */
const at =
  (trigger: unknown, input: z.ZodType = z.object({})) =>
  () =>
    defineWorkflow({ ...announce, name: "timed", trigger: trigger as never, input: input as never });

/** Defines an operation named `name` that uses `uses`, when called. */
const using =
  (uses: readonly unknown[], name = "quote") =>
  () =>
    defineOperation({ name, input: z.object({}), uses: uses as never, run: async () => null });

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
    expect(at({ schedule: "0 9 * * *", timezone: "+05:30" })).toThrow(/its timezone "\+05:30" is no IANA time zone/);
    expect(at({ schedule: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow(
      'Workflow "timed": its timezone "Mars/Olympus" is no IANA time zone, such as "Europe/Amsterdam"',
    );
  });

  it("refuses a schedule for a workflow whose input refuses {}, what a scheduled run starts with", () => {
    const daily = { schedule: "0 9 * * *" };
    expect(at(daily, z.object({ to: z.string().default("all"), note: z.string().optional() }))).not.toThrow();
    expect(at(daily, z.object({ to: z.string() }))).toThrow(
      'Workflow "timed": a scheduled run starts with the input {}, which its input schema refuses: make each field optional or give it a default',
    );
    expect(at("manual", z.object({ to: z.string() }))).not.toThrow();
  });
});

describe("defineOperation", () => {
  const notes = collection({ name: "notes", key: "id", fields: { id: "text", text: "text" } });

  it("is an operation of the vendor operations, from its file, with the strongest effect of what it uses", () => {
    const op = using([notes.get, ghost.post.publish, notes.save])();
    expect(op).toMatchObject({
      kind: "op",
      vendor: "operations",
      resource: "quote",
      name: "run",
      id: "operations.quote.run",
      effect: "publish",
      idempotent: true,
      uses: [notes.get, ghost.post.publish, notes.save],
      file: fileURLToPath(import.meta.url),
    });
    expect(op).not.toHaveProperty("app");
    expect(isOperation(op)).toBe(true);
    expect(isOperation(notes.get)).toBe(false);
    // A read with nothing to call; idempotent when every call is.
    expect(using([])()).toMatchObject({ effect: "read", idempotent: true });
    expect(using([notes.get])()).toMatchObject({ effect: "read", idempotent: true });
    expect(using([notes.get, ghost.post.create])()).toMatchObject({ effect: "write", idempotent: false });
  });

  it("refuses a name a collection could not have, and anything in uses but a connector's or a collection's operation", () => {
    expect(using([], "Quote")).toThrow(
      'defineOperation("Quote"): the name must be a lowercase letter, then letters and digits, such as "quote"',
    );
    expect(using([], "make-quote")).toThrow(/the name must be a lowercase letter/);
    expect(using(["approval"])).toThrow(
      'defineOperation("quote"): uses lists operations only; an approval, a sleep or ctx.all is a workflow\'s, around operations',
    );
    expect(using([using([], "inner")()])).toThrow(
      "defineOperation(\"quote\"): operations.inner.run is a company operation; an operation calls connectors' and collections' operations only: call both from a workflow",
    );
  });

  it("refuses a definition from code with no file, which could not be outlined", () => {
    const define = new Function("defineOperation", "def", "return defineOperation(def)") as (
      d: typeof defineOperation,
      def: unknown,
    ) => unknown;
    expect(() =>
      define(defineOperation, { name: "nowhere", input: z.object({}), uses: [], run: async () => null }),
    ).toThrow(/^Operation "nowhere" was defined from code with no file .*: its outline is read from the file/);
  });
});
