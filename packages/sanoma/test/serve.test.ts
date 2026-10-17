import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/config.ts";
import { appOptions } from "../src/serve.ts";

/** Sets these variables for the test, and unsets the other launcher variables appOptions reads. */
function environment(values: Record<string, string>) {
  const names = ["SANOMA_APP_HOST", "SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_GITHUB_REPO"];
  for (const name of names) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const GITHUB = {
  SANOMA_GITHUB_CLIENT_ID: "id",
  SANOMA_GITHUB_CLIENT_SECRET: "secret",
  SANOMA_GITHUB_REPO: "acme/company",
};

describe("appOptions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes the host, and no login, from an environment without GitHub's variables", async () => {
    environment({});
    expect(await appOptions()).toEqual({ host: undefined });
    environment({ SANOMA_APP_HOST: "localhost" });
    expect(await appOptions()).toEqual({ host: "localhost" });
  });

  it("refuses a host beyond this machine without GitHub sign-in", async () => {
    environment({ SANOMA_APP_HOST: "0.0.0.0" });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/^SANOMA_APP_HOST=0\.0\.0\.0 needs GitHub sign-in/);
  });

  it("signs in with GitHub when all three are set", async () => {
    environment({ ...GITHUB, SANOMA_APP_HOST: "0.0.0.0", SANOMA_SECRETS_KEY: "key" });
    const { host, login } = await appOptions();
    expect(host).toBe("0.0.0.0");
    expect(login?.name).toBe("github");
  });

  it("names the GitHub variables missing when only some are set", async () => {
    environment({ SANOMA_GITHUB_CLIENT_ID: "id", SANOMA_SECRETS_KEY: "key" });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/SANOMA_GITHUB_CLIENT_SECRET, SANOMA_GITHUB_REPO not set$/);
  });

  it("names SANOMA_SECRETS_KEY when GitHub sign-in has no key to sign with", async () => {
    environment({ ...GITHUB, SANOMA_SECRETS_KEY: "" });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/SANOMA_SECRETS_KEY/);
  });

  it("reads the client id and secret the GitHub App stored when only the repository is set", async () => {
    const asked: string[][] = [];
    const stored = async (names: string[]) => {
      asked.push(names);
      return new Map([
        ["SANOMA_GITHUB_CLIENT_ID", "stored-id"],
        ["SANOMA_GITHUB_CLIENT_SECRET", "stored-secret"],
      ]);
    };
    environment({ SANOMA_GITHUB_REPO: "acme/company", SANOMA_APP_HOST: "0.0.0.0", SANOMA_SECRETS_KEY: "key" });
    expect((await appOptions(stored)).login?.name).toBe("github");
    expect(asked).toEqual([["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET"]]);
    // Nothing stored: the same refusal as before, naming what is missing.
    await expect(appOptions(async () => new Map())).rejects.toThrow(
      /SANOMA_GITHUB_CLIENT_ID, SANOMA_GITHUB_CLIENT_SECRET not set$/,
    );
    // Without the repository, nothing is read.
    environment({});
    expect(await appOptions(stored)).toEqual({ host: undefined });
    expect(asked).toHaveLength(1);
  });
});
