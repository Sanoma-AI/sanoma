import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { configuredSecrets } from "../src/credentials.ts";
import type { Db } from "../src/db.ts";
import type { SecretStoreFactory } from "../src/secret-store.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";
import { checkSecretConfiguration, memorySecretStore, SecretAccess, SecretStoreError } from "../src/secret-store.ts";
import {
  checkAuthenticationStore,
  decodeCredentials,
  defineAuthentication,
  encodeCredentials,
} from "../src/authentication.ts";

describe("secret store contract", () => {
  it("closes a runtime-owned adapter once and leaves a standalone adapter caller-owned", async () => {
    const store = memorySecretStore();
    const close = vi.fn<() => Promise<void>>(async () => {});
    const adapter = { ...store, close };
    const owned = configuredSecrets(
      { store: { kind: "runtime", id: store.id, capabilities: store.capabilities, create: () => adapter } },
      vi.fn<() => Promise<Db>>(),
    );
    await Promise.all([owned.close(), owned.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    await configuredSecrets({ store: adapter }, vi.fn<() => Promise<Db>>()).close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("validates factory metadata without binding or opening a database and refuses unbound use", () => {
    const store = memorySecretStore();
    const create = vi.fn<SecretStoreFactory["create"]>(() => store);
    const factory: SecretStoreFactory = { kind: "runtime", id: store.id, capabilities: store.capabilities, create };
    checkSecretConfiguration({ store: factory });
    expect(create).not.toHaveBeenCalled();
    expect(() => new SecretAccess({ store: factory }, store)).toThrow("invalid_configuration");
    const database = vi.fn<() => Promise<Db>>();
    const bound = configuredSecrets({ store: factory }, database);
    expect(bound.store).toBe(store);
    expect(create).toHaveBeenCalledWith({ database });
    expect(database).not.toHaveBeenCalled();
  });

  it("rejects inconsistent factories and sanitizes construction errors without a fallback", () => {
    const store = memorySecretStore();
    const factory = { kind: "runtime" as const, id: store.id, capabilities: store.capabilities };
    for (const create of [
      () => ({ ...store, id: "other" }),
      () => ({ ...store, capabilities: { ...store.capabilities, conditionalWrites: "none" as const } }),
      () => {
        throw new Error("sensitive database URL");
      },
    ]) {
      expect(() => configuredSecrets({ store: { ...factory, create } }, vi.fn<() => Promise<Db>>())).toThrow(
        "Secret store: invalid_configuration",
      );
    }
  });
  it.each([{}, { writable: false }, { maxBytes: 64 }, { deletion: "soft-delete" as const }])(
    "passes conformance: %j",
    async (options) => {
      const checks = await checkSecretStore(memorySecretStore(options), "test");
      expect(checks.length).toBeGreaterThan(2);
      expect(checks.filter((c) => !c.ok)).toEqual([]);
    },
  );

  it("resolves only the selected binding, never a same-named environment variable", async () => {
    const store = memorySecretStore();
    await store.write({ namespace: "prod", path: "external/token" }, "stored", { expectedVersion: null, by: "test" });
    const env = vi.fn<() => string>(() => "environment");
    const access = new SecretAccess(
      {
        store,
        namespace: "prod",
        bindings: {
          TOKEN: { path: "external/token", management: "external" },
          BOOT: { env: "HOST_TOKEN" },
        },
      },
      store,
      env,
    );
    expect(await access.get("TOKEN")).toBe("stored");
    expect(await access.get("MISSING")).toBeUndefined();
    expect(env).not.toHaveBeenCalled();
    expect(await access.get("BOOT")).toBe("environment");
    await expect(access.write("TOKEN", "replacement", { expectedVersion: null, by: "test" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(access.ensure("BOOT", () => "generated")).resolves.toBe("environment");
    expect(access.location("TOKEN")).toEqual({
      store: "memory",
      namespace: "prod",
      path: "external/token",
      management: "external",
    });
  });

  it("cannot generate an absent external value, mutate read-only stores or rely on nonconditional providers", async () => {
    const store = memorySecretStore();
    const external = new SecretAccess({ bindings: { TOKEN: { env: "EMPTY" } } }, store, () => undefined);
    await expect(external.ensure("TOKEN", () => "generated")).rejects.toMatchObject({ code: "read_only" });
    const unsafe = { ...store, capabilities: { ...store.capabilities, conditionalWrites: "none" as const } };
    expect((await checkSecretStore(unsafe, "unsupported")).every((c) => c.ok)).toBe(true);
  });

  it("does not let changed configuration or returned values mutate stored state", async () => {
    const store = memorySecretStore();
    const bindings = { TOKEN: { path: "first", management: "sanoma" as const } };
    const access = new SecretAccess({ bindings }, store);
    bindings.TOKEN.path = "second";
    const value = await access.write("TOKEN", "one", { expectedVersion: null, by: "test" });
    value.value = "mutated";
    expect(await access.get("TOKEN")).toBe("one");
    expect(await store.read({ namespace: "default", path: "second" })).toBeUndefined();
  });

  it("versions prevent stale writes after deletion and recreation", async () => {
    const store = memorySecretStore();
    const access = new SecretAccess({}, store);
    const first = await access.write("TOKEN", "one", { expectedVersion: null, by: "test" });
    await access.delete("TOKEN", { expectedVersion: first.version, by: "test" });
    await access.write("TOKEN", "two", { expectedVersion: null, by: "test" });
    await expect(access.write("TOKEN", "stale", { expectedVersion: first.version, by: "test" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("sanitizes arbitrary provider exceptions and validates without reading values", async () => {
    const store = memorySecretStore();
    const read = vi.fn<() => Promise<never>>(async () => {
      throw new Error("secret-from-provider");
    });
    const access = new SecretAccess({}, { ...store, read });
    await access.validate();
    expect(read).not.toHaveBeenCalled();
    await expect(access.get("TOKEN")).rejects.toEqual(new SecretStoreError("unavailable"));
  });

  it.each([
    { namespace: "" },
    { bindings: { bad: { env: "TOKEN" } } },
    { bindings: { TOKEN: { path: "secret", env: "TOKEN", management: "sanoma" } } },
    { bindings: { TOKEN: { path: "secret" } } },
    { bindings: { TOKEN: { env: "TOKEN", management: "sanoma" } } },
    { bindings: { TOKEN: { env: "TOKEN", host: "true" } } },
    { bindings: { TOKEN: { path: "token", management: "sanoma", host: true } } },
    { bindings: { TOKEN: { bootstrap: "SANOMA_SIGNING_KEY", host: true } } },
    { bindings: { TOKEN: { bootstrap: "SANOMA_SIGNING_KEY", env: undefined, host: true } } },
    { bindings: { FIRST: { env: "TOKEN", host: true }, SECOND: { env: "TOKEN", host: true } } },
  ])("rejects ambiguous config without repeating its contents: %j", (config) => {
    expect(() => checkSecretConfiguration(config as never)).toThrow("Secret store: invalid_configuration");
  });
});

describe("authentication bundles", () => {
  const auth = defineAuthentication({
    kind: "oauth2",
    version: 1,
    storage: { writable: true, maxBytes: 256, conditionalWrites: true },
    oauth: {
      authorizeUrl: "https://oauth.example.test/authorize",
      tokenUrl: "https://oauth.example.test/token",
      scopes: [],
      pkce: true,
      clientAuthentication: "client_secret_basic",
    },
  });
  it("encodes one versioned lifecycle unit and validates on retrieval", () => {
    const value = { accessToken: "access", tokenType: "bearer", refreshToken: "refresh", expiresAt: 1 };
    expect(decodeCredentials(auth, encodeCredentials(auth, value))).toEqual(value);
    expect(() => decodeCredentials(auth, '{"version":2,"value":{}}')).toThrow("invalid_value");
    expect(() => decodeCredentials(auth, '{"version":1,"value":{"refreshToken":"x"}}')).toThrow("invalid_value");
  });
  it("does not leak validator or serialization errors", () => {
    const evil = defineAuthentication({
      kind: "api-key",
      version: 1,
      schema: z.string().refine(() => {
        throw new Error("plaintext");
      }),
      storage: { writable: false, maxBytes: 256, conditionalWrites: false },
    });
    expect(() => encodeCredentials(evil, "plaintext")).toThrow("Secret store: invalid_value");
  });
  it("checks ownership, conditional writes and size before consent", () => {
    const caps = memorySecretStore().capabilities;
    expect(() => checkAuthenticationStore(auth, caps, "external")).toThrow("read_only");
    expect(() => checkAuthenticationStore(auth, { ...caps, conditionalWrites: "none" }, "sanoma")).toThrow(
      "unsupported",
    );
    expect(() => checkAuthenticationStore(auth, { ...caps, maxBytes: 10 }, "sanoma")).toThrow("too_large");
  });
  it("workload identity does not require persisted credentials", () => {
    const identity = defineAuthentication({ kind: "workload-identity" });
    expect(() =>
      checkAuthenticationStore(identity, memorySecretStore({ writable: false }).capabilities, "external"),
    ).not.toThrow();
    expect(() => encodeCredentials(identity, "token")).toThrow("unsupported");
  });
});
