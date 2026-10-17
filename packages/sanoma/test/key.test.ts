import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSecretsKey, writeSecretsKey } from "../src/key.ts";

let dir = "";
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureSecretsKey", () => {
  it("makes a key when none is set, into a new .env readable by its owner alone, and says so in one line", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-key-"));
    vi.stubEnv("SANOMA_SECRETS_KEY", undefined);
    const log = vi.fn<(line: string) => void>();
    ensureSecretsKey(dir, log);
    const key = process.env.SANOMA_SECRETS_KEY!;
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`SANOMA_SECRETS_KEY=${key}\n`);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(log.mock.calls).toEqual([[expect.stringMatching(/^created SANOMA_SECRETS_KEY in .*\.env: it encrypts/)]]);
    // Set now, so a second call leaves everything as it is.
    ensureSecretsKey(dir, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`SANOMA_SECRETS_KEY=${key}\n`);
  });

  it("appends to an existing .env on a line of its own, and leaves one alone when the key is set", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-key-"));
    writeFileSync(join(dir, ".env"), "GHOST_ADMIN_URL=https://ghost.example.test");
    ensureSecretsKey(dir, () => undefined);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("GHOST_ADMIN_URL=https://ghost.example.test");

    vi.stubEnv("SANOMA_SECRETS_KEY", "");
    ensureSecretsKey(dir, () => undefined);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      `GHOST_ADMIN_URL=https://ghost.example.test\nSANOMA_SECRETS_KEY=${process.env.SANOMA_SECRETS_KEY}\n`,
    );
  });
});

describe("writeSecretsKey", () => {
  it("keeps a key the file already sets, and replaces an empty one", () => {
    dir = mkdtempSync(join(tmpdir(), "sanoma-key-"));
    const file = join(dir, ".env");
    writeFileSync(file, "SANOMA_SECRETS_KEY=kept\n");
    expect(writeSecretsKey(file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("SANOMA_SECRETS_KEY=kept\n");

    writeFileSync(file, "SANOMA_SECRETS_KEY=\n");
    const key = writeSecretsKey(file);
    expect(readFileSync(file, "utf8")).toBe(`SANOMA_SECRETS_KEY=\nSANOMA_SECRETS_KEY=${key}\n`);
  });
});
