import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthenticationError,
  defineAuthentication,
  verifyAuthentication,
  type AuthenticationIdentity,
} from "../src/authentication.ts";

const stored = {
  kind: "api-key",
  version: 1,
  schema: z.object({}),
  storage: { writable: true, maxBytes: 64, conditionalWrites: true },
} as const;
const check = (verify: () => Promise<AuthenticationIdentity>) =>
  verifyAuthentication(defineAuthentication({ ...stored, verify }), {});

describe("authentication health", () => {
  it("preserves only verified identity facts and normalizes grants", async () => {
    const identity = { account: "organization", scopes: ["write", "read", "read"], token: "private-value" };
    const actual = await check(async () => identity);
    expect(actual).toEqual({ account: "organization", scopes: ["read", "write"] });
    expect(actual.scopes).not.toBe(identity.scopes);
    expect(identity.scopes).toEqual(["write", "read", "read"]);
  });

  it("distinguishes verified expiry from an unavailable provider", async () => {
    await expect(
      check(async () => ({
        account: "organization",
        scopes: [],
        expiresAt: Date.now() - 1,
      })),
    ).rejects.toMatchObject({ problem: "expired", retryable: false });
    const error = await check(async () => {
      throw new Error("SDK header: private-value", { cause: "private-value" });
    }).catch((failure: unknown) => failure);
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
      const actual = await check(async () => {
        throw failure;
      }).catch((e: unknown) => e);
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
      await expect(check(async () => identity as AuthenticationIdentity)).rejects.toMatchObject({
        problem: "unavailable",
      });
    }
    await expect(
      check(async () => {
        throw { name: "AuthenticationError", problem: "private-value", message: "private-value" };
      }),
    ).rejects.toMatchObject({ problem: "unavailable", message: "Authentication: unavailable" });
    await expect(verifyAuthentication(defineAuthentication(stored), {})).rejects.toMatchObject({
      problem: "unsupported",
    });
  });
});
