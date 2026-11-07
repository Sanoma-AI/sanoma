import { checkDerivedHost } from "sanoma/testing/host";
import { describe, expect, it } from "vitest";
import { host, hostSlug } from "../src/connector.ts";

// `cloud.host`, aligned with `cloudflare.host`: its decisions alone, its repository and branch derived.

describe("cloud.host", () => {
  it("passes the derived-host checks", () => {
    expect(checkDerivedHost(host, { name: "acme" }).filter((check) => !check.ok)).toEqual([]);
  });

  it("takes its slug from its hostname, as from the deprecated domains.app", () => {
    expect(hostSlug({ hostname: "acme.sanoma.work" })).toBe("acme");
    expect(hostSlug({ domains: { app: "acme.sanoma.work" } })).toBe("acme");
  });
});
