import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  defineAuthentication,
  verifyAuthentication,
  type AuthenticationIdentity,
} from "../src/authentication.ts";

const method = (verify: () => Promise<AuthenticationIdentity>) =>
  defineAuthentication({ kind: "workload-identity", verify });

describe("authentication health", () => {
  it("preserves only verified identity facts and normalizes grants", async () => {
    const identity = { account: "organization", scopes: ["write", "read", "read"], token: "private-value" };
    const actual = await verifyAuthentication(method(async () => identity));
    expect(actual).toEqual({ account: "organization", scopes: ["read", "write"] });
    expect(actual.scopes).not.toBe(identity.scopes);
    expect(identity.scopes).toEqual(["write", "read", "read"]);
  });

  it("distinguishes verified expiry from an unavailable provider", async () => {
    await expect(
      verifyAuthentication(
        method(async () => ({
          account: "organization",
          scopes: [],
          expiresAt: Date.now() - 1,
        })),
      ),
    ).rejects.toMatchObject({ problem: "expired", retryable: false });
    const error = await verifyAuthentication(
      method(async () => {
        throw new Error("SDK header: private-value", { cause: "private-value" });
      }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ problem: "unavailable", retryable: true });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("private-value");
    expect(JSON.stringify(error)).not.toContain("private-value");
  });

  it("keeps known lifecycle states but discards a verifier's message, stack and cause", async () => {
    for (const problem of ["revoked", "uncertain", "rejected"] as const) {
      const failure = Object.assign(new AuthenticationError(problem), {
        message: "private-value",
        stack: "private-value",
        cause: "private-value",
      });
      const actual = await verifyAuthentication(
        method(async () => {
          throw failure;
        }),
      ).catch((e: unknown) => e);
      expect(actual).toMatchObject({ problem, message: `Authentication: ${problem}`, retryable: false });
      expect(actual).not.toBe(failure);
      expect(actual).not.toHaveProperty("cause");
      expect((actual as Error).stack).not.toContain("private-value");
    }
  });

  it("does not trust arbitrary provider codes or malformed identities", async () => {
    const invalid = [
      null,
      {},
      { account: "", scopes: [] },
      { account: "org", scopes: [1] },
      { account: "org", scopes: [], expiresAt: Number.NaN },
    ];
    for (const identity of invalid) {
      await expect(verifyAuthentication(method(async () => identity as AuthenticationIdentity))).rejects.toMatchObject({
        problem: "unavailable",
      });
    }
    await expect(
      verifyAuthentication(
        method(async () => {
          throw { name: "AuthenticationError", problem: "private-value", message: "private-value" };
        }),
      ),
    ).rejects.toMatchObject({ problem: "unavailable", message: "Authentication: unavailable" });
    await expect(verifyAuthentication(defineAuthentication({ kind: "workload-identity" }))).rejects.toMatchObject({
      problem: "unsupported",
    });
  });
});
