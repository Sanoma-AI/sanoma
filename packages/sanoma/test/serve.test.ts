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

  it("takes the host, and no login, from an environment without GitHub's variables", () => {
    environment({});
    expect(appOptions()).toEqual({ host: undefined });
    environment({ SANOMA_APP_HOST: "localhost" });
    expect(appOptions()).toEqual({ host: "localhost" });
  });

  it("refuses a host beyond this machine without GitHub sign-in", () => {
    environment({ SANOMA_APP_HOST: "0.0.0.0" });
    expect(appOptions).toThrow(UsageError);
    expect(appOptions).toThrow(/^SANOMA_APP_HOST=0\.0\.0\.0 needs GitHub sign-in/);
  });

  it("signs in with GitHub when all three are set", () => {
    environment({ ...GITHUB, SANOMA_APP_HOST: "0.0.0.0", SANOMA_SECRETS_KEY: "key" });
    const { host, login } = appOptions();
    expect(host).toBe("0.0.0.0");
    expect(login?.name).toBe("github");
  });

  it("names the GitHub variables missing when only some are set", () => {
    environment({ SANOMA_GITHUB_CLIENT_ID: "id", SANOMA_SECRETS_KEY: "key" });
    expect(appOptions).toThrow(UsageError);
    expect(appOptions).toThrow(/SANOMA_GITHUB_CLIENT_SECRET, SANOMA_GITHUB_REPO not set$/);
  });

  it("names SANOMA_SECRETS_KEY when GitHub sign-in has no key to sign with", () => {
    environment({ ...GITHUB, SANOMA_SECRETS_KEY: "" });
    expect(appOptions).toThrow(UsageError);
    expect(appOptions).toThrow(/SANOMA_SECRETS_KEY/);
  });
});
