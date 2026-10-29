import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "../src/credentials.ts";
import { memorySecrets, resolveSecrets } from "../src/index.ts";
import { secret } from "../src/secret.ts";
import { secret as fromResources } from "@sanoma-ai/workflows/resources";

describe("secret", () => {
  it("is a frozen marker naming the secret, from the entry data files import it from", () => {
    expect(secret("DB_PASSWORD")).toEqual({ $secret: "DB_PASSWORD" });
    expect(secret("DB_PASSWORD", { generate: true })).toEqual({ $secret: "DB_PASSWORD", generate: true });
    expect(Object.isFrozen(secret("X"))).toBe(true);
    expect(fromResources).toBe(secret);
  });

  it("refuses a name that is not upper case; sanoma's own are for a host's secrets, which its type checks", () => {
    expect(() => secret("db_password")).toThrow(/a secret's name is an environment variable's/);
    expect(secret("SANOMA_SECRETS_KEY")).toEqual({ $secret: "SANOMA_SECRETS_KEY" });
  });
});

describe("resolveSecrets", () => {
  it("replaces each marker in a value with the stored value, at any depth", async () => {
    const secrets = memorySecrets({ TOKEN: "t0ken" });
    const value = { name: "x", token: secret("TOKEN"), env: [{ name: "A", value: secret("TOKEN") }], n: 1, no: null };
    expect(await resolveSecrets(value, secrets)).toEqual({
      name: "x",
      token: "t0ken",
      env: [{ name: "A", value: "t0ken" }],
      n: 1,
      no: null,
    });
    // The value given is left as it was: it may be a checkpoint's.
    expect(value.token).toEqual({ $secret: "TOKEN" });
  });

  it("generates a secret marked `generate` once, storing it before it returns", async () => {
    const secrets = memorySecrets();
    const ensure = vi.spyOn(secrets, "ensure");
    const first = await resolveSecrets({ password: secret("DB_PASSWORD", { generate: true }) }, secrets);
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.password, "base64url")).toHaveLength(32);
    expect(await secrets.get("DB_PASSWORD")).toBe(first.password);
    const again = await resolveSecrets({ password: secret("DB_PASSWORD", { generate: true }) }, secrets);
    expect(again.password).toBe(first.password);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("fails the call, for good, on a secret nothing stored", async () => {
    await expect(resolveSecrets({ token: secret("MISSING") }, memorySecrets())).rejects.toMatchObject({
      code: "driver_failed",
      retryable: false,
      message: "The secret MISSING is not set: store it before applying",
    });
  });
});

describe("encrypt and decrypt", () => {
  it("round-trips under the key, as v1:<iv>:<ciphertext and tag>, a new iv each time", () => {
    const sealed = encrypt("PASSWORD", "hunter2");
    expect(sealed).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain("hunter2");
    expect(encrypt("PASSWORD", "hunter2")).not.toBe(sealed);
    expect(decrypt("PASSWORD", sealed)).toBe("hunter2");
  });

  it("refuses a value moved to another name's row, and a malformed one, naming the row", () => {
    const sealed = encrypt("PASSWORD", "hunter2");
    expect(() => decrypt("OTHER", sealed)).toThrow(/invalid_value/);
    expect(() => decrypt("PASSWORD", "v1:x:y")).toThrow(/invalid_value/);
  });

  it("refuses plaintext values", () => {
    expect(() => decrypt("PASSWORD", "plain-old")).toThrow("invalid_value");
  });

  it("refuses without a key, a key of the wrong length, and a value stored under another key, naming the variable", () => {
    const sealed = encrypt("PASSWORD", "hunter2");
    try {
      vi.stubEnv("SANOMA_SECRETS_KEY", undefined);
      expect(() => encrypt("PASSWORD", "x")).toThrow(/SANOMA_SECRETS_KEY must be 32 random bytes/);
      expect(() => decrypt("PASSWORD", sealed)).toThrow(/SANOMA_SECRETS_KEY must be 32 random bytes/);
      vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(16).toString("base64"));
      expect(() => encrypt("PASSWORD", "x")).toThrow("SANOMA_SECRETS_KEY must be 32 random bytes");
      vi.stubEnv("SANOMA_SECRETS_KEY", randomBytes(32).toString("base64"));
      expect(() => decrypt("PASSWORD", sealed)).toThrow("invalid_value");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
