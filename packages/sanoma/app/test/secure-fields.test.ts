import { describe, expect, it } from "vitest";
import { secureFields, secureInput } from "../src/form/secure-fields.ts";

describe("secure authentication fields", () => {
  it("renders multifield credentials without carrying defaults, and preserves optional fields", () => {
    const fields = secureFields({
      type: "object",
      required: ["user", "password"],
      properties: {
        user: { type: "string" },
        password: { type: "string", default: "never-prefill" },
        options: { type: "object" },
        otp: { type: "string" },
      },
    });
    expect(JSON.stringify(fields)).not.toContain("never-prefill");
    expect(secureInput(fields, { user: "alice", password: "synthetic", options: '{"region":"eu"}' })).toEqual({
      user: "alice",
      password: "synthetic",
      options: { region: "eu" },
    });
  });
  it("keeps root string keys distinct from object properties named $value", () => {
    expect(secureInput(secureFields({ type: "string" }), { $value: "synthetic" })).toBe("synthetic");
    expect(
      secureInput(secureFields({ type: "object", properties: { $value: { type: "string" } } }), {
        $value: "synthetic",
      }),
    ).toEqual({ $value: "synthetic" });
  });
  it("never echoes a malformed credential in a parsing error", () => {
    expect(() =>
      secureInput(secureFields({ type: "object", required: ["key"], properties: { key: { type: "object" } } }), {
        key: "sensitive-invalid-json",
      }),
    ).toThrow("Enter valid JSON for key");
  });
});
