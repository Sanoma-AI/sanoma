import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentKey } from "@sanoma-ai/workflows";
import { ensureDeploymentKeys, writeDeploymentKeys } from "../src/key.ts";

const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-key-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const clear = () => {
  for (const key of ["SANOMA_SECRETS_KEY", "SANOMA_SIGNING_KEY", "SANOMA_SECRETS_KEY_FILE", "SANOMA_SIGNING_KEY_FILE"])
    vi.stubEnv(key, undefined);
};

describe("deployment bootstrap", () => {
  it("creates independent keys in a protected local file, then keeps them on restart", () => {
    clear();
    const dir = directory();
    const log = vi.fn<(line: string) => void>();
    ensureDeploymentKeys(dir, log);
    const file = join(dir, ".env");
    const text = readFileSync(file, "utf8");
    expect(deploymentKey("SANOMA_SIGNING_KEY")).not.toEqual(deploymentKey("SANOMA_SECRETS_KEY"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    clear();
    ensureDeploymentKeys(dir, log);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(log).toHaveBeenCalledTimes(2);
  });
  it("external stores only require app signing bootstrap", () => {
    clear();
    const dir = directory();
    ensureDeploymentKeys(dir, () => {}, { externalStore: true });
    expect(Object.keys(parseEnv(readFileSync(join(dir, ".env"), "utf8")))).toEqual(["SANOMA_SIGNING_KEY"]);
    expect(process.env.SANOMA_SECRETS_KEY).toBeUndefined();
  });
  it("respects mounted keys and refuses env/file ambiguity", () => {
    clear();
    const dir = directory();
    const file = join(dir, "key");
    const key = randomBytes(32);
    writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600 });
    vi.stubEnv("SANOMA_SECRETS_KEY_FILE", file);
    ensureDeploymentKeys(dir, () => {});
    expect(deploymentKey("SANOMA_SECRETS_KEY")).toEqual(key);
    expect(process.env.SANOMA_SECRETS_KEY).toBeUndefined();
    vi.stubEnv("SANOMA_SECRETS_KEY", key.toString("base64"));
    expect(() => deploymentKey("SANOMA_SECRETS_KEY")).toThrow("Set only one");
    expect(() => ensureDeploymentKeys(dir, () => {})).toThrow("Set only one");
  });
  it("reports missing/unreadable/malformed keys without repeating their contents", () => {
    expect(() => deploymentKey("SANOMA_SECRETS_KEY", {})).toThrow("32 random bytes");
    expect(() => deploymentKey("SANOMA_SECRETS_KEY", { SANOMA_SECRETS_KEY_FILE: "/no-such-key" })).toThrow(
      "could not be read",
    );
    expect(() => deploymentKey("SANOMA_SECRETS_KEY", { SANOMA_SECRETS_KEY: "secret-invalid" })).toThrow(
      "32 random bytes",
    );
  });
  it("initializes a new company without replacing existing file inputs", () => {
    const file = join(directory(), ".env");
    writeDeploymentKeys(file);
    const first = readFileSync(file, "utf8");
    writeDeploymentKeys(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(Object.keys(parseEnv(first)).toSorted()).toEqual(["SANOMA_SECRETS_KEY", "SANOMA_SIGNING_KEY"]);
  });
});
