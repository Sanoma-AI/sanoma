import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "sanoma/workflows/shared";
import { appOptions, parseDomains, resetNotices, wakeRoute } from "../src/serve.ts";

/** Sets these variables for the test, and unsets the other launcher variables appOptions reads. */
function environment(values: Record<string, string>) {
  const names = [
    "SANOMA_APP_HOST",
    "SANOMA_HOSTNAME",
    "SANOMA_HOST_URL",
    "SANOMA_AGENT_URL",
    "SANOMA_COMPANY",
    "SANOMA_ROUTER_SECRET",
    "SANOMA_GITHUB_CLIENT_ID",
    "SANOMA_GITHUB_CLIENT_SECRET",
    "SANOMA_DOMAINS",
  ];
  for (const name of names) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const KEY = Buffer.alloc(32, 1).toString("base64");
/** A router's secret as one is: visible ASCII, 32 characters or more. */
const SECRET = "a-router's-secret-0123456789abcdefgh";

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
    const { host, login, social } = await appOptions();
    expect(host).toBe("0.0.0.0");
    expect(login?.name).toBe("staff");
    expect(social).toBeUndefined();
    environment({ ...GITHUB, SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
    const options = await appOptions();
    expect(options.login?.name).toBe("staff");
    // The same client for the public sites' logins, for visitors.
    expect(options.social).toEqual({ github: { clientId: "id", clientSecret: "secret" } });
  });

  it("takes the agent address from SANOMA_HOSTNAME or SANOMA_HOST_URL beyond this machine, and refuses what names none", async () => {
    const beyond = { SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY };
    for (const address of [
      { SANOMA_HOSTNAME: "app.sanoma.example" },
      { SANOMA_HOSTNAME: "App.Sanoma.Example" },
      { SANOMA_HOST_URL: "http://10.0.0.7:3000" },
      { SANOMA_HOST_URL: " https://intranet/ " },
    ] as Record<string, string>[]) {
      environment({ ...beyond, ...address });
      expect((await appOptions()).login?.name, JSON.stringify(address)).toBe("staff");
    }
    for (const hostname of ["https://app.sanoma.example", "app.sanoma.example:8443", "app.sanoma.example/mcp", "app"]) {
      environment({ ...beyond, SANOMA_HOSTNAME: hostname });
      await expect(appOptions(), hostname).rejects.toThrow(UsageError);
      await expect(appOptions(), hostname).rejects.toThrow(`SANOMA_HOSTNAME is "${hostname}": write the hostname`);
    }
    for (const url of ["app.sanoma.example", "https://app.sanoma.example/app", "ftp://app.sanoma.example"]) {
      environment({ ...beyond, SANOMA_HOST_URL: url });
      await expect(appOptions(), url).rejects.toThrow(UsageError);
      await expect(appOptions(), url).rejects.toThrow(`SANOMA_HOST_URL: "${url}" is not where an app is served`);
    }
    // On this machine nobody signs in, so neither is read.
    environment({ SANOMA_HOSTNAME: "https://app.sanoma.example", SANOMA_HOST_URL: "nothing" });
    expect(await appOptions()).toEqual({ host: undefined });
  });

  it("takes a router's address first, all three of its variables, the secret one a router can send", async () => {
    const beyond = { SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY };
    const routed = {
      SANOMA_AGENT_URL: "https://mcp.sanoma.example/mcp",
      SANOMA_COMPANY: "acme",
      SANOMA_ROUTER_SECRET: SECRET,
    };
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      resetNotices();
      // An address, though no hostname or URL of its own is set: nothing is said.
      environment({ ...beyond, ...routed });
      const options = await appOptions();
      expect(options.login?.name).toBe("staff");
      // A config with no router of its own serves none, and reads the secret for nothing else.
      expect(options.router).toBeUndefined();
      expect(said).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
    }
    for (const [missing, named] of [
      [{ SANOMA_COMPANY: "" }, 'SANOMA_COMPANY is ""'],
      [{ SANOMA_COMPANY: "acme.eu" }, 'SANOMA_COMPANY is "acme.eu"'],
      [{ SANOMA_ROUTER_SECRET: "" }, "SANOMA_ROUTER_SECRET is not set"],
      [{ SANOMA_ROUTER_SECRET: "s3cret" }, "SANOMA_ROUTER_SECRET is not one a router can send: it must have 32"],
      [
        { SANOMA_ROUTER_SECRET: `${SECRET} x` },
        "SANOMA_ROUTER_SECRET is not one a router can send: it must be visible",
      ],
      [{ SANOMA_AGENT_URL: "https://mcp.sanoma.example" }, 'SANOMA_AGENT_URL is "https://mcp.sanoma.example"'],
    ] as const) {
      environment({ ...beyond, ...routed, ...missing });
      await expect(appOptions(), named).rejects.toThrow(UsageError);
      await expect(appOptions(), named).rejects.toThrow(named);
    }
  });

  it("serves a config's router with its master secret on any host, and refuses its hostname where the app or a site answers", async () => {
    const router = { hostname: "mcp.sanoma.example", companies: { collection: "companies", url: "url" } };
    // Wherever the app listens; trimmed, and a blank one is none: the router then forwards nothing.
    environment({ SANOMA_ROUTER_SECRET: ` ${SECRET} ` });
    expect(await appOptions(undefined, router)).toEqual({ host: undefined, router: { secret: SECRET } });
    environment({ SANOMA_ROUTER_SECRET: " " });
    expect(await appOptions(undefined, router)).toEqual({ host: undefined, router: {} });
    // A config without one reads nothing of it, whatever the variable holds.
    environment({ SANOMA_ROUTER_SECRET: "short" });
    expect(await appOptions()).toEqual({ host: undefined });
    for (const [set, named] of [
      [{ SANOMA_ROUTER_SECRET: "short" }, "SANOMA_ROUTER_SECRET is not one a router can send: it must have 32"],
      [{ SANOMA_ROUTER_SECRET: `${SECRET}\u00e9` }, "SANOMA_ROUTER_SECRET is not one a router can send: it must be"],
      [
        { SANOMA_HOSTNAME: "MCP.sanoma.example" },
        "The config's `router.hostname`, mcp.sanoma.example, is SANOMA_HOSTNAME, the app's own hostname",
      ],
      [
        { SANOMA_DOMAINS: "www=sanoma.example,docs=mcp.sanoma.example" },
        "The config's `router.hostname`, mcp.sanoma.example, is the domain of the public site docs",
      ],
    ] as const) {
      environment({ SANOMA_ROUTER_SECRET: SECRET, ...set });
      await expect(appOptions(undefined, router), named).rejects.toThrow(UsageError);
      await expect(appOptions(undefined, router), named).rejects.toThrow(named);
    }
    // Another hostname and other domains beside it are fine.
    environment({
      SANOMA_ROUTER_SECRET: SECRET,
      SANOMA_HOSTNAME: "app.sanoma.example",
      SANOMA_DOMAINS: "www=sanoma.example",
    });
    expect((await appOptions(undefined, router)).router).toEqual({ secret: SECRET });
  });

  it("says once, beyond this machine with no agent address, that no agent can sign in, and what to set", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const notices = () => said.mock.calls.filter(([line]) => String(line).includes("no agent address"));
      // With an address, and on this machine: nothing is said.
      environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY, SANOMA_HOSTNAME: "app.sanoma.example" });
      await appOptions();
      environment({});
      await appOptions();
      expect(notices()).toEqual([]);
      environment({ SANOMA_APP_HOST: "0.0.0.0", SANOMA_SIGNING_KEY: KEY });
      resetNotices();
      await appOptions();
      // A reload reads the options again: it is not said twice.
      await appOptions();
      expect(notices()).toHaveLength(1);
      expect(notices()[0]![0]).toMatch(/^No agent can sign in at \/mcp: .*Set SANOMA_HOSTNAME .* or SANOMA_HOST_URL /);
    } finally {
      said.mockRestore();
    }
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
    const options = await appOptions(stored);
    expect(options.login?.name).toBe("staff");
    expect(options.social).toEqual({ github: { clientId: "stored-id", clientSecret: "stored-secret" } });
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
