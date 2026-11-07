import { SecretAccess, SecretStoreError, type SecretStore } from "./secret-store.ts";

const assert = (condition: unknown) => {
  if (!condition) throw new Error("Conformance failure");
};

const rejects = async (run: () => Promise<unknown>, code: string) => {
  try {
    await run();
  } catch (error) {
    assert(error instanceof SecretStoreError && error.code === code);
    return;
  }
  throw new Error("Expected refusal");
};

export interface SecretStoreCheck {
  name: string;
  ok: boolean;
}

/**
 * Destructive conformance checks on a fresh, disposable namespace. Never use a production
 * namespace. The caller supplies a store scoped to test credentials and cleans up retained
 * versions/namespaces according to the provider's retention rules. No result contains values.
 */
export async function checkSecretStore(store: SecretStore, namespace: string): Promise<SecretStoreCheck[]> {
  const access = new SecretAccess({ store, namespace }, store);
  const other = new SecretAccess({ store, namespace: `${namespace}-other` }, store);
  const results: SecretStoreCheck[] = [];
  const check = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch {
      results.push({ name, ok: false });
    }
  };
  await check("validate and missing read", async () => {
    await access.validate();
    assert((await access.read("ABSENT")) === undefined);
  });
  await check("external ownership", async () => {
    const external = new SecretAccess(
      { store, namespace, bindings: { EXISTING: { path: "existing", management: "external" } } },
      store,
    );
    await rejects(() => external.write("EXISTING", "value", { expectedVersion: null, by: "check" }), "read_only");
    await rejects(() => external.delete("EXISTING", { expectedVersion: "v1", by: "check" }), "read_only");
  });
  if (!store.capabilities.writable) {
    await check("read-only provider", () =>
      rejects(() => access.write("VALUE", "value", { expectedVersion: null, by: "check" }), "read_only"),
    );
    return results;
  }
  if (store.capabilities.conditionalWrites === "none") {
    await check("unsupported conditional writes", () =>
      rejects(() => access.ensure("VALUE", () => "value"), "unsupported"),
    );
    return results;
  }
  await check("concurrent create and namespace separation", async () => {
    const values = await Promise.all(Array.from({ length: 8 }, (_, i) => access.ensure("RACE", () => String(i))));
    assert(new Set(values).size === 1);
    assert((await other.get("RACE")) === undefined);
  });
  await check("replace rejects stale versions", async () => {
    const one = await access.write("REPLACE", "one", { expectedVersion: null, by: "check" });
    const two = await access.write("REPLACE", "two", { expectedVersion: one.version, by: "check" });
    assert(one.version !== two.version);
    await rejects(() => access.write("REPLACE", "stale", { expectedVersion: one.version, by: "check" }), "conflict");
    assert((await access.get("REPLACE")) === "two");
  });
  await check("UTF-8 size rejection", () =>
    rejects(
      () =>
        access.write("OVERSIZE", "x".repeat(store.capabilities.maxBytes + 1), { expectedVersion: null, by: "check" }),
      "too_large",
    ),
  );
  await check("deletion semantics", async () => {
    const one = await access.write("DELETE", "one", { expectedVersion: null, by: "check" });
    if (store.capabilities.deletion === "unsupported") {
      await rejects(() => access.delete("DELETE", { expectedVersion: one.version, by: "check" }), "unsupported");
      return;
    }
    await rejects(() => access.delete("DELETE", { expectedVersion: "incorrect", by: "check" }), "conflict");
    await access.delete("DELETE", { expectedVersion: one.version, by: "check" });
    assert((await access.read("DELETE")) === undefined);
  });
  return results;
}
