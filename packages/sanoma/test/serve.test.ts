import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/config.ts";
import { appOptions, parseDomains, wakeRoute } from "../src/serve.ts";

/** Sets these variables for the test, and unsets the other launcher variables appOptions reads. */
function environment(values: Record<string, string>) {
  const names = ["SANOMA_APP_HOST", "SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_DOMAINS"];
  for (const name of names) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const GITHUB = {
  SANOMA_GITHUB_CLIENT_ID: "id",
  SANOMA_GITHUB_CLIENT_SECRET: "secret",
};

describe("parseDomains", () => {
  it("reads each public site's domain by its name, and none from nothing", () => {
    expect(parseDomains("www=sanoma.example")).toEqual({ www: "sanoma.example" });
    expect(parseDomains("constructor=sanoma.example")).toEqual({ constructor: "sanoma.example" });
    expect(parseDomains("www=sanoma.example, docs=docs.sanoma.example")).toEqual({
      www: "sanoma.example",
      docs: "docs.sanoma.example",
    });
    expect(parseDomains(undefined)).toBeUndefined();
    expect(parseDomains("")).toBeUndefined();
  });

  it("refuses a pair that is not <site>=<hostname>, and a site named twice", () => {
    for (const value of [
      "www",
      "www=",
      "=sanoma.example",
      "www=sanoma",
      "www=Sanoma.example",
      "www=https://sanoma.example",
      "www=sanoma.example:443",
      "Www=sanoma.example",
      "www=a.example=b",
      "www=sanoma.example,",
      "www=a.example,www=b.example",
    ]) {
      expect(() => parseDomains(value), value).toThrow(UsageError);
    }
    expect(() => parseDomains("www=sanoma")).toThrow(
      'SANOMA_DOMAINS has "www=sanoma": write <site>=<hostname>, each site once, such as www=sanoma.example',
    );
  });
});

describe("appOptions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes the public sites' domains from SANOMA_DOMAINS", async () => {
    environment({ SANOMA_DOMAINS: "www=sanoma.example" });
    expect(await appOptions()).toEqual({ host: undefined, domains: { www: "sanoma.example" } });
    environment({ SANOMA_DOMAINS: "www" });
    await expect(appOptions()).rejects.toThrow(UsageError);
  });

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

  it("signs in with GitHub when both are set", async () => {
    environment({ ...GITHUB, SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64") });
    const { host, login } = await appOptions();
    expect(host).toBe("0.0.0.0");
    expect(login?.name).toBe("github");
  });

  it("names the GitHub variables missing when only some are set", async () => {
    environment({ SANOMA_GITHUB_CLIENT_ID: "id", SANOMA_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64") });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/: SANOMA_GITHUB_CLIENT_SECRET not set$/);
  });

  it("names SANOMA_SIGNING_KEY when GitHub sign-in has no key to sign with", async () => {
    environment({ ...GITHUB, SANOMA_SIGNING_KEY: "" });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/SANOMA_SIGNING_KEY/);
  });

  it("reads the client id and secret the GitHub App stored on a host beyond this machine, or with one set", async () => {
    const asked: string[][] = [];
    const stored = async (names: string[]) => {
      asked.push(names);
      return new Map([
        ["SANOMA_GITHUB_CLIENT_ID", "stored-id"],
        ["SANOMA_GITHUB_CLIENT_SECRET", "stored-secret"],
      ]);
    };
    environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64") });
    expect((await appOptions(stored)).login?.name).toBe("github");
    expect(asked).toEqual([["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET"]]);
    // Nothing stored: the same refusal as before, naming what is missing.
    await expect(appOptions(async () => new Map())).rejects.toThrow(
      /^SANOMA_APP_HOST=0\.0\.0\.0 needs GitHub sign-in: set SANOMA_GITHUB_CLIENT_ID, SANOMA_GITHUB_CLIENT_SECRET$/,
    );
    // A read that fails is a UsageError, saying why.
    await expect(appOptions(async () => Promise.reject(new Error("no database")))).rejects.toThrow(
      /^GitHub sign-in could not read the stored client id and secret: no database$/,
    );
    // One set on this machine: the other is read, and the environment's wins.
    environment({ SANOMA_GITHUB_CLIENT_ID: "id", SANOMA_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64") });
    expect((await appOptions(stored)).login?.name).toBe("github");
    expect(asked).toHaveLength(2);
    // On this machine with neither set, nothing is read: no login.
    environment({});
    expect(await appOptions(stored)).toEqual({ host: undefined });
    expect(asked).toHaveLength(2);
  });
});

type OnWake = () => void | Promise<void>;

/** `GET /wake<query>`, through `wakeRoute`. */
const wake = (query: string, onWake?: OnWake, log = vi.fn<(line: string) => void>()) =>
  wakeRoute({ onWake, log }).handle(new Request(`http://127.0.0.1:3000/wake${query}`));

describe("wakeRoute", () => {
  it("answers GET /wake 204, never cached, and calls onWake each time, whatever the query", async () => {
    const onWake = vi.fn<OnWake>();
    expect(wakeRoute({ log: vi.fn<(line: string) => void>() })).toMatchObject({ method: "GET", path: "/wake" });
    for (const query of ["", "?generation=7", "?x"]) {
      const res = await wake(query, onWake);
      expect(res.status).toBe(204);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(onWake).toHaveBeenCalledTimes(3);
    expect((await wake("")).status).toBe(204);
  });

  it("logs an onWake that throws or rejects, and still answers 204", async () => {
    const log = vi.fn<(line: string) => void>();
    const res = await wake(
      "",
      () => {
        throw new Error("no worker");
      },
      log,
    );
    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledWith("a wake failed: no worker");
    const rejected = await wake("", () => Promise.reject(new Error("still starting")), log);
    expect(rejected.status).toBe(204);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("a wake failed: still starting"));
  });
});
