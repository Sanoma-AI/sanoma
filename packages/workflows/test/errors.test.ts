import { describe, expect, it } from "vitest";
import { errorInfo } from "../src/errors.ts";
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

describe("errorInfo", () => {
  it("keeps the vendor's answer from a DriverError and the data of the runtime's errors", () => {
    const vendor = new DriverError("Ghost said no", { retryable: false, status: 422, vendorCode: "ValidationError" });
    expect(errorInfo(vendor)).toEqual({
      code: "driver_failed",
      name: "DriverError",
      message: "Ghost said no",
      status: 422,
      vendorCode: "ValidationError",
      retryable: false,
    });
    expect(errorInfo(new PolicyDeniedError("ghost.post.publish", "not today"))).toMatchObject({
      code: "policy_denied",
      data: { op: "ghost.post.publish", reason: "not today" },
    });
  });

  it("keeps no data, status or vendor code from an error the runtime did not make", () => {
    // Like an HTTP client's error a driver let escape: the vendor's response under `data`.
    const escaped = Object.defineProperty(Object.assign(new Error("fetch failed"), { status: 500 }), "data", {
      get: () => ({ body: "the vendor's whole reply" }),
      enumerable: true,
    });
    const store = Object.assign(new Error("corrupt ledger line"), { retryable: false, data: { line: 3 } });
    expect(errorInfo(escaped)).toEqual({ name: "Error", message: "fetch failed" });
    expect(errorInfo(store)).toEqual({ name: "Error", message: "corrupt ledger line", retryable: false });
  });
});
