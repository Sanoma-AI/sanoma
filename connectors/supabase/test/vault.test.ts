import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({
  query: vi.fn<(sql: string, values: unknown[]) => Promise<{ rows: { result: unknown }[] }>>(),
  end: vi.fn<() => Promise<void>>(),
  on: vi.fn<() => void>(),
}));
vi.mock("pg", () => ({
  Pool: class {
    query = transport.query;
    end = transport.end;
    on = transport.on;
  },
}));
import { supabaseVault } from "../src/vault.ts";
const address = { namespace: "company", path: "GMAIL" };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe("Supabase Vault transport", () => {
  it("loads the bootstrap URL only on use and never needs a Sanoma encryption key", async () => {
    vi.stubEnv("SUPABASE_VAULT_DATABASE_URL", undefined);
    const store = supabaseVault();
    await expect(store.validate("company")).rejects.toMatchObject({ code: "invalid_configuration" });
    vi.stubEnv("SUPABASE_VAULT_DATABASE_URL", "postgres://scoped@localhost/test");
    vi.stubEnv("SANOMA_SECRETS_KEY", undefined);
    transport.query.mockResolvedValue({ rows: [{ result: { protocol: 1, writable: true } }] });
    await store.validate("company");
    expect(transport.query).toHaveBeenCalledWith(expect.stringContaining("$1, $2, $3, $4, $5, $6"), [
      "validate",
      "company",
      null,
      null,
      null,
      null,
    ]);
    await store.close();
    expect(transport.end).toHaveBeenCalledOnce();
  });
  it.each([
    ["42501", "denied"],
    ["SV001", "read_only"],
    ["SV002", "conflict"],
    ["23505", "conflict"],
    ["SV003", "too_large"],
    ["42883", "invalid_configuration"],
    ["08006", "unavailable"],
  ])("sanitizes %s as %s", async (code, expected) => {
    vi.stubEnv("SUPABASE_VAULT_DATABASE_URL", "postgres://scoped@localhost/test");
    transport.query.mockRejectedValue(Object.assign(new Error("sensitive provider payload"), { code }));
    const store = supabaseVault();
    await expect(store.read(address)).rejects.toMatchObject({
      code: expected,
      message: `Secret store: ${expected}`,
    });
    await store.close();
  });
  it("parameterizes values and rejects malformed responses without exposing them", async () => {
    vi.stubEnv("SUPABASE_VAULT_DATABASE_URL", "postgres://scoped@localhost/test");
    const store = supabaseVault();
    transport.query.mockResolvedValue({
      rows: [{ result: { value: "synthetic", version: "a".repeat(64), extra: "discard" } }],
    });
    expect(await store.write(address, "synthetic", { expectedVersion: null, by: "alice" })).toEqual({
      value: "synthetic",
      version: "a".repeat(64),
    });
    expect(transport.query.mock.calls[0]![0]).not.toContain("synthetic");
    transport.query.mockResolvedValue({ rows: [{ result: { value: "synthetic", version: "bad" } }] });
    await expect(store.read(address)).rejects.toMatchObject({ code: "unavailable" });
    transport.query.mockResolvedValue({ rows: [{ result: null }] });
    expect(await store.read(address)).toBeUndefined();
    await store.close();
  });
  it("refuses invalid values and read-only writes before SQL", async () => {
    const store = supabaseVault();
    await expect(
      store.write(address, "💚".repeat(17_000), { expectedVersion: null, by: "alice" }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(store.write(address, "\0", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
      code: "invalid_value",
    });
    const readonly = supabaseVault({ writable: false });
    await expect(readonly.write(address, "x", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
      code: "read_only",
    });
    await expect(readonly.delete(address, { expectedVersion: "v1", by: "alice" })).rejects.toMatchObject({
      code: "read_only",
    });
    expect(transport.query).not.toHaveBeenCalled();
  });
});
