import { describe, expect, it } from "vitest";
import {
  type AgentAddress,
  agentAddressAt,
  agentAddressFrom,
  checkAgentAddress,
  NO_AGENT_ADDRESS,
  resourceMetadataOf,
} from "../src/index.ts";

// An instance's one agent address: made from the app's URL or the launcher's environment,
// written as it is compared, and refused when the staff login could not serve it.

const APP = "https://acme.example";
const ADDRESS: AgentAddress = { issuer: `${APP}/auth/better-auth`, resource: `${APP}/mcp` };

describe("agentAddressAt", () => {
  it("makes one address from an app's URL, however it is written: no trailing slash, no default port", () => {
    for (const url of [APP, `${APP}/`, "HTTPS://Acme.Example:443/", `${APP}//`]) {
      expect(agentAddressAt(url), url).toEqual(ADDRESS);
    }
    expect(agentAddressAt("http://10.0.0.7:3000/")).toEqual({
      issuer: "http://10.0.0.7:3000/auth/better-auth",
      resource: "http://10.0.0.7:3000/mcp",
    });
  });

  it("refuses what is no origin: a path, a query, a fragment, a user, no scheme", () => {
    for (const url of [
      `${APP}/app`,
      `${APP}/?x=1`,
      `${APP}/#x`,
      "https://ada@acme.example",
      "acme.example",
      "ftp://acme.example",
      "",
    ]) {
      expect(() => agentAddressAt(url), url).toThrow(`${JSON.stringify(url)} is not where an app is served`);
    }
  });
});

describe("agentAddressFrom", () => {
  it("reads the hostname first, then the instance's own URL, each trimmed, and none from neither", () => {
    expect(agentAddressFrom({ SANOMA_HOSTNAME: " Acme.Example " })).toEqual(ADDRESS);
    expect(agentAddressFrom({ SANOMA_HOSTNAME: "acme.example", SANOMA_HOST_URL: "http://10.0.0.7:3000" })).toEqual(
      ADDRESS,
    );
    // What a hostname cannot say: a port, an address, a single label, plain http.
    for (const [url, origin] of [
      ["http://10.0.0.7:3000/ ", "http://10.0.0.7:3000"],
      ["http://intranet", "http://intranet"],
      ["https://acme.acme-co.workers.dev/", "https://acme.acme-co.workers.dev"],
    ]) {
      expect(agentAddressFrom({ SANOMA_HOSTNAME: "", SANOMA_HOST_URL: url }), url).toEqual(agentAddressAt(origin!));
    }
    for (const env of [{}, { SANOMA_HOSTNAME: "", SANOMA_HOST_URL: " " }]) {
      expect(agentAddressFrom(env)).toBeUndefined();
    }
  });

  it("names the variable whose value gives no address", () => {
    for (const hostname of ["https://acme.example", "acme.example:8443", "acme.example/mcp", "acme"]) {
      expect(() => agentAddressFrom({ SANOMA_HOSTNAME: hostname }), hostname).toThrow(
        `SANOMA_HOSTNAME is ${JSON.stringify(hostname)}: write the hostname`,
      );
    }
    for (const url of ["acme.example", "https://acme.example/app", "ftp://acme.example", "https://acme.example?x"]) {
      expect(() => agentAddressFrom({ SANOMA_HOST_URL: url }), url).toThrow(
        `SANOMA_HOST_URL: ${JSON.stringify(url)} is not where an app is served`,
      );
    }
    // A hostname that is one wins over a URL that is none: the URL is not read.
    expect(agentAddressFrom({ SANOMA_HOSTNAME: "acme.example", SANOMA_HOST_URL: "nothing" })).toEqual(ADDRESS);
  });

  it("is named, with both variables, by what an instance without one says", () => {
    expect(NO_AGENT_ADDRESS).toMatch(/no agent address\. Set SANOMA_HOSTNAME .* or SANOMA_HOST_URL /);
  });
});

describe("checkAgentAddress", () => {
  it("takes what agentAddressAt makes, and refuses an address the login could not serve", () => {
    for (const url of [APP, "http://10.0.0.7:3000"]) expect(() => checkAgentAddress(agentAddressAt(url))).not.toThrow();
    expect(() => checkAgentAddress({ ...ADDRESS, issuer: `${ADDRESS.issuer}/` })).toThrow(/as it is compared/);
    expect(() => checkAgentAddress({ ...ADDRESS, issuer: APP })).toThrow(
      /its path must be \/auth\/better-auth.*sanoma#777/,
    );
    expect(() => checkAgentAddress({ ...ADDRESS, resource: APP })).toThrow(/it needs a path.*sanoma#777/);
  });
});

describe("resourceMetadataOf", () => {
  it("is RFC 9728's well-known path with the resource's own, on the resource's origin", () => {
    expect(resourceMetadataOf(ADDRESS)).toEqual({
      path: "/.well-known/oauth-protected-resource/mcp",
      url: `${APP}/.well-known/oauth-protected-resource/mcp`,
    });
  });
});
