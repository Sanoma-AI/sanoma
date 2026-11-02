import { type CallContext, diffDeclared, dnsRecord, memorySecrets } from "@sanoma-ai/workflows";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeResend } from "../src/fake.ts";
import { resend } from "../src/resources.ts";

// The `resend.domain` type: what a data file declares, drift on its status, and the fake's
// verification, which the features cannot drive (a Given seeds through operations only).

let seq = 0;
/** Each call its own idempotency key, as a run gives them: the fake answers a repeated one from its first reply. */
const call = (op: string): CallContext => ({
  idempotencyKey: `run-1:${++seq}`,
  runId: "run-1",
  opId: `resend.domain.${op}`,
  attempt: 1,
  secrets: memorySecrets(),
});

const op = (fake: ReturnType<typeof fakeResend>, name: string, input: Record<string, unknown>) =>
  fake.driver.ops[`domain.${name}`]!(input, call(name));

type Changed = { id: string; state: Record<string, unknown> & { dns_records: unknown[] } };

describe("resend.domain", () => {
  it("is declared by its name, which a data file writes in lower case, and holds none of Resend's fields", () => {
    expect(resend.domain({ name: "example.com", region: "eu-west-1" })).toMatchObject({
      vendor: "resend",
      type: "domain",
      name: "example.com",
      desired: { name: "example.com", region: "eu-west-1" },
    });
    expect(() => resend.domain({ name: "Example.com" })).toThrow(/lower case/);
    // A vendor-owned field.
    expect(() => resend.domain({ name: "example.com", status: "verified" })).toThrow(/status/);
  });

  it("drifts while Resend has not verified it", () => {
    const desired = { name: "example.com" };
    const state = { name: "example.com", region: "us-east-1", custom_return_path: "send", id: "d", status: "pending" };
    expect(diffDeclared(resend.domain, state, desired)).toEqual([
      { path: "status", desired: "verified", actual: "pending" },
    ]);
    expect(diffDeclared(resend.domain, { ...state, status: "verified" }, desired)).toEqual([]);
  });

  describe("on the fake", () => {
    it("leaves a domain pending until Resend finds its records, then plans no change", async () => {
      const fake = fakeResend();
      const { id, state } = (await op(fake, "create", { desired: { name: "example.com" } })) as Changed;
      expect(state).toMatchObject({ status: "pending", region: "us-east-1", custom_return_path: "send" });
      // What `cloudflare.records` takes, in the shape both connectors share.
      expect(z.array(dnsRecord).parse(state.dns_records)).toEqual([
        { type: "TXT", name: "resend._domainkey.example.com", content: expect.stringMatching(/^p=/), ttl: 1 },
        {
          type: "MX",
          name: "send.example.com",
          content: "feedback-smtp.us-east-1.amazonses.com",
          priority: 10,
          ttl: 1,
        },
        { type: "TXT", name: "send.example.com", content: "v=spf1 include:amazonses.com ~all", ttl: 1 },
      ]);
      const desired = { name: "example.com" };
      expect(await op(fake, "plan", { id, desired })).toMatchObject({ action: "update" });
      fake.verifyDomain(id);
      expect(await op(fake, "plan", { id, desired })).toMatchObject({ action: "none" });
      fake.failDomain(id);
      expect(fake.state.domains[id]!.status).toBe("failed");
      // An update asks again: the fake checks until told what Resend found.
      expect(await op(fake, "update", { id, desired })).toMatchObject({ state: { status: "pending" } });
    });

    it("names a subdomain's records relative to the zone, as Resend does, and reads them in full", async () => {
      const fake = fakeResend();
      const { id, state } = (await op(fake, "create", { desired: { name: "mail.example.com" } })) as Changed;
      expect(fake.state.domains[id]!.records.map((r) => r.name)).toEqual([
        "resend._domainkey.mail",
        "send.mail",
        "send.mail",
      ]);
      expect(state).toMatchObject({ custom_return_path: "send" });
      expect(state.dns_records.map((r) => (r as { name: string }).name)).toEqual([
        "resend._domainkey.mail.example.com",
        "send.mail.example.com",
        "send.mail.example.com",
      ]);
    });

    it("makes a domain moved to another region anew, with a new key", async () => {
      const fake = fakeResend();
      const before = (await op(fake, "create", { desired: { name: "example.com" } })) as Changed;
      const desired = { name: "example.com", region: "eu-west-1" };
      const plan = await op(fake, "plan", { id: before.id, desired });
      expect(plan).toMatchObject({ action: "replace", replace: ["region"] });
      const after = (await op(fake, "update", { id: before.id, desired, expect: plan })) as Changed;
      expect(after.id).not.toBe(before.id);
      expect(after.state.dns_records[0]).not.toEqual(before.state.dns_records[0]);
      expect(after.state.dns_records[1]).toMatchObject({ content: "feedback-smtp.eu-west-1.amazonses.com" });
      expect(Object.keys(fake.state.domains)).toEqual([after.id]);
    });
  });
});
