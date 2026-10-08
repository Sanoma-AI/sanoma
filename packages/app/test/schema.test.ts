import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildInput,
  type Field,
  fieldsOf,
  fromLocalInput,
  initialValues,
  issueTarget,
  toLocalInput,
} from "../src/form/schema.ts";

// The start form's logic, on the JSON Schema describeConfig sends. No database, no build.
const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" });

const input = z.object({
  title: z.string().min(1).describe("What to call it"),
  note: z.string().optional(),
  count: z.number().int().default(1),
  ratio: z.number().optional(),
  launchAt: z.iso.datetime({ offset: true }),
  channel: z.enum(["blog", "email"]),
  urgent: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  people: z.array(z.object({ name: z.string(), email: z.string().optional() })),
  details: z.object({ owner: z.string() }).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
const fields = fieldsOf(jsonSchema(input))!;
const field = (key: string) => fields.find((f) => f.key === key)!;

describe("fieldsOf", () => {
  it("gives each property a control by its type, with whether it is required and its default", () => {
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["title", "string", true],
      ["note", "string", false],
      ["count", "integer", false],
      ["ratio", "number", false],
      ["launchAt", "datetime", true],
      ["channel", "enum", true],
      ["urgent", "boolean", false],
      ["tags", "array", false],
      ["people", "array", true],
      ["details", "object", false],
      ["extra", "json", false],
    ]);
    expect(field("title")).toMatchObject({ description: "What to call it" });
    expect(field("count")).toMatchObject({ default: 1 });
    expect(field("channel")).toMatchObject({ options: ["blog", "email"] });
    expect(field("people")).toMatchObject({ item: { kind: "object", fields: [{ key: "name" }, { key: "email" }] } });
  });

  it("gives nothing for an input that is not an object with properties, so the form takes the whole input as JSON", () => {
    expect(fieldsOf(jsonSchema(z.array(z.string())))).toBeUndefined();
    expect(fieldsOf(jsonSchema(z.union([z.object({ a: z.string() }), z.string()])))).toBeUndefined();
    expect(fieldsOf(jsonSchema(z.string()))).toBeUndefined();
  });
});

/** What the form sends with these values filled in over its starting ones. */
const filled = (values: Record<string, unknown>) =>
  buildInput(fields, { ...initialValues(fields), ...values } as never);

describe("buildInput", () => {
  it("leaves out optional fields left empty, so the workflow's defaults apply, and sends a required empty text", () => {
    const { input: built, errors } = filled({ title: "", note: "", count: "", tags: [] });
    expect(errors).toEqual({});
    expect(built).toHaveProperty("title", "");
    expect(built).not.toHaveProperty("note");
    expect(built).not.toHaveProperty("count");
    expect(built).not.toHaveProperty("tags");
    // Optional and left wholly empty, though its own field is required: left out.
    expect(built).not.toHaveProperty("details");
    // A required list is sent even when empty.
    expect(built).toHaveProperty("people", []);
  });

  it("reads numbers, choices, lists and JSON as their values", () => {
    const { input: built } = filled({
      title: "Launch",
      count: "3",
      ratio: "0.5",
      channel: "1",
      urgent: true,
      tags: ["a", "b"],
      people: [{ name: "Ann", email: "" }],
      details: { owner: "Bo" },
      extra: '{"k": 1}',
    });
    expect(built).toMatchObject({
      title: "Launch",
      count: 3,
      ratio: 0.5,
      channel: "email",
      urgent: true,
      tags: ["a", "b"],
      people: [{ name: "Ann" }],
      details: { owner: "Bo" },
      extra: { k: 1 },
    });
  });

  it("names the fields whose values it cannot read", () => {
    const { errors } = filled({ count: "three", extra: "{", launchAt: "not a time", people: [{ name: "" }] });
    expect(errors).toEqual({ count: "Not a number", extra: "Not valid JSON", launchAt: "Not a date and time" });
  });
});

describe("issueTarget", () => {
  it("puts an issue on the deepest field the form shows, by index in a list", () => {
    expect(issueTarget(fields, ["people", 0, "name"], "Required")).toEqual({
      name: "people[0].name",
      message: "Required",
    });
    expect(issueTarget(fields, ["tags", 2], "Too long")).toEqual({ name: "tags[2]", message: "Too long" });
    expect(issueTarget(fields, ["details", "owner"], "Required")).toEqual({
      name: "details.owner",
      message: "Required",
    });
  });

  it("puts an issue inside a JSON field on that field, with the rest of the path", () => {
    expect(issueTarget(fields, ["extra", "k", 0], "Expected string")).toEqual({
      name: "extra",
      message: "k[0]: Expected string",
    });
  });

  it("gives nothing for an issue about the whole input or a field the form does not show", () => {
    expect(issueTarget(fields, [], "Expected object")).toBeUndefined();
    expect(issueTarget(fields, ["nope"], "Unrecognized key")).toBeUndefined();
  });

  it("takes the whole input as one JSON field when the form has no fields", () => {
    const whole: Field[] = [{ key: "input", label: "Input (JSON)", kind: "json", required: true }];
    expect(issueTarget(whole, ["input", 1], "Expected string")).toEqual({
      name: "input",
      message: "[1]: Expected string",
    });
  });
});

describe("datetime-local values", () => {
  it("round-trips a local time through an ISO time with this machine's offset", () => {
    const iso = fromLocalInput("2026-10-07T09:30")!;
    expect(iso).toMatch(/^2026-10-07T09:30:00[+-]\d{2}:\d{2}$/);
    expect(toLocalInput(iso)).toBe("2026-10-07T09:30");
    expect(Date.parse(iso)).toBe(new Date("2026-10-07T09:30").getTime());
  });

  it("reads nothing from something that is not a time", () => {
    expect(fromLocalInput("not a time")).toBeUndefined();
    expect(toLocalInput("not a time")).toBe("");
  });
});
