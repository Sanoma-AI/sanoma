import { checkDerivedHost } from "sanoma/testing/host";
import { describe, expect, it } from "vitest";
import { host } from "../src/connector.ts";

// `cloud.host`, aligned with `cloudflare.host`: its decisions alone, its repository and branch derived.

describe("cloud.host", () => {
  it("passes the derived-host checks", () => {
    expect(checkDerivedHost(host, { hostname: "acme.sanoma.work" }).filter((check) => !check.ok)).toEqual([]);
  });

  it("takes its address at sanoma.work only, and no name", () => {
    expect(host({ hostname: "acme.sanoma.work" }).desired).toEqual({ hostname: "acme.sanoma.work" });
    expect(() => host({ hostname: "www.acme.com" })).toThrow(/sanoma\.work/);
    expect(() => host({ hostname: "-acme.sanoma.work" })).toThrow(/sanoma\.work/);
    expect(() => host({ name: "acme", hostname: "acme.sanoma.work" } as never)).toThrow(/name/);
  });
});
