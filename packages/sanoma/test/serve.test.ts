import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/config.ts";
import { appOptions, parseDomains, wakeRoute } from "../src/serve.ts";

/** Sets these variables for the test, and unsets the other launcher variables appOptions reads. */
function environment(values: Record<string, string>) {
  const names = ["SANOMA_APP_HOST", "SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET", "SANOMA_DOMAINS"];
  for (const name of names) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const KEY = Buffer.alloc(32, 1).toString("base64");

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

  it("takes the host, and the loopback picker, on this machine, whatever GitHub's variables say", async () => {
    environment({});
    expect(await appOptions()).toEqual({ host: undefined });
    environment({ ...GITHUB, SANOMA_APP_HOST: "localhost" });
    expect(await appOptions()).toEqual({ host: "localhost" });
  });

  it("signs people in with the staff login beyond this machine, GitHub or not", async () => {
    environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
    const { host, login } = await appOptions();
    expect(host).toBe("0.0.0.0");
    expect(login?.name).toBe("staff");
    environment({ ...GITHUB, SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
    expect((await appOptions()).login?.name).toBe("staff");
  });

  it("names SANOMA_SIGNING_KEY when the staff login has no key to sign with", async () => {
    environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: "" });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/SANOMA_SIGNING_KEY/);
  });

  it("names the GitHub variables missing when only some are set", async () => {
    environment({ SANOMA_GITHUB_CLIENT_ID: "id", SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
    await expect(appOptions()).rejects.toThrow(UsageError);
    await expect(appOptions()).rejects.toThrow(/: SANOMA_GITHUB_CLIENT_SECRET not set$/);
  });

  it("reads the client id and secret the GitHub App stored, on a host beyond this machine", async () => {
    const asked: string[][] = [];
    const stored = async (names: string[]) => {
      asked.push(names);
      return new Map([
        ["SANOMA_GITHUB_CLIENT_ID", "stored-id"],
        ["SANOMA_GITHUB_CLIENT_SECRET", "stored-secret"],
      ]);
    };
    environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
    expect((await appOptions(stored)).login?.name).toBe("staff");
    expect(asked).toEqual([["SANOMA_GITHUB_CLIENT_ID", "SANOMA_GITHUB_CLIENT_SECRET"]]);
    // Nothing stored: no GitHub, and still a login.
    expect((await appOptions(async () => new Map())).login?.name).toBe("staff");
    // A read that fails is a UsageError, saying why.
    await expect(appOptions(async () => Promise.reject(new Error("no database")))).rejects.toThrow(
      /^GitHub sign-in could not read the stored client id and secret: no database$/,
    );
    // On this machine nothing is read: the loopback picker.
    environment({ SANOMA_GITHUB_CLIENT_ID: "id" });
    expect(await appOptions(stored)).toEqual({ host: undefined });
    expect(asked).toHaveLength(1);
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
