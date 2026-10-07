import { describe, expect, it } from "vitest";
import { DriverError, errorCode, PolicyDeniedError, RejectedError, SanomaError } from "../src/index.ts";

describe("errorCode", () => {
  it("reads an own code property, so a copy of the error keeps it", () => {
    const denied = new PolicyDeniedError("ghost.post.publish", "not today");
    expect(errorCode(denied)).toBe("policy_denied");
    // What DBOS hands back for a failed run: a new object carrying the enumerable own properties.
    const copy = JSON.parse(JSON.stringify({ ...denied, name: denied.name, message: denied.message }));
    expect(copy).toMatchObject({ code: "policy_denied", data: { op: "ghost.post.publish", reason: "not today" } });
    expect(errorCode(copy)).toBe("policy_denied");
    expect(errorCode(Object.assign(new Error("x"), { code: "run_not_found" }))).toBe("run_not_found");
  });

  it("recognises the driver's error, and only codes of ours", () => {
    expect(errorCode(new DriverError("503", { retryable: true }))).toBe("driver_failed");
    expect(errorCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeUndefined();
    expect(errorCode(Object.create({ code: "policy_denied" }))).toBeUndefined();
    expect(errorCode("policy_denied")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it("names the rejection's approval, title and approver", () => {
    const err = new RejectedError("Review copy", { id: "lead" }, "wrong date", "approval-2");
    expect(err).toBeInstanceOf(SanomaError);
    expect(err.message).toBe('"Review copy" was rejected by lead: wrong date');
    expect({ ...err }).toMatchObject({
      code: "approval_rejected",
      data: { title: "Review copy", by: { id: "lead" }, note: "wrong date", approvalId: "approval-2" },
    });
  });
});
