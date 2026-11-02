import { live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, memorySecrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { cloudflareDriver } from "../src/driver.ts";
import { fakeCloudflare } from "../src/fake.ts";
import type { ZoneRecord } from "../src/ops.ts";
import { cfList, replayOptions } from "./replay.ts";

// `cloudflare.records` over the fixtures written from Cloudflare's API reference (the `records-*`
// ones; the features replay the others) and on the fake: the batches it sends, adoption, the
// refusals, and a plan of records not known yet.

const { play, fixture, sent } = replay(replayOptions);

const ZONE_ID = "00000000000000000000000000000001";
const MARK = "sanoma:sanoma.work/check";
const DNS = `/client/v4/zones/${ZONE_ID}/dns_records`;
const DKIM = {
  type: "TXT",
  name: "check-dkim._domainkey.sanoma.work",
  content: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcheck",
};
const MX = {
  type: "MX",
  name: "check-send.sanoma.work",
  content: "feedback-smtp.us-east-1.amazonses.com",
  priority: 10,
};
const SPF = { type: "TXT", name: "check-send.sanoma.work", content: "v=spf1 include:amazonses.com ~all" };
const desired = { zone: "sanoma.work", name: "check", records: [DKIM, MX, SPF] };
const ID = "sanoma.work/check";

let calls = 0;
/** A call of its own: the fake answers a repeated idempotency key with the first reply. */
const callWith = (): CallContext => ({
  idempotencyKey: `run-1:${++calls}`,
  runId: "run-1",
  opId: "cloudflare.records.create",
  attempt: 1,
  secrets: memorySecrets(),
});
let driver: ReturnType<typeof cloudflareDriver>;
beforeEach(() => {
  driver = cloudflareDriver({ timeoutMs: 200 });
});
/** A set's operation's answer, as the tests read it. */
type Answer = { id: string; gone?: boolean; state: { records: unknown[] } & Record<string, unknown> };
const op = async (name: string, input: object) => (await driver.ops[name]!(input, callWith())) as Answer;

/** The batch requests sent, their bodies. */
const batches = () => sent.filter((r) => r.path.endsWith("/dns_records/batch")).map((r) => r.body);
/** The `records-conflict` fixture, the other records at check-send.sanoma.work answered with `others`. */
const withOthers = (others: object[]) => [
  ...fixture("records-conflict").slice(0, 3),
  cfList(`${DNS}?name.exact=check-send.sanoma.work`, others),
];
const unmarked = (record: object, comment?: string) => ({
  id: "00000000000000000000000000000009",
  ttl: 1,
  ...record,
  ...(comment && { comment }),
});

describe.skipIf(live)("cloudflare.records over the driver", () => {
  it("creates a set in one batch: each record posted with the set's mark, never proxied, ttl automatic", async () => {
    play("records-create");
    const made = await op("records.create", { desired });
    expect(made).toMatchObject({
      id: ID,
      state: { zone_id: ZONE_ID, record_ids: [3, 2, 4].map((n) => String(n).padStart(32, "0")) },
    });
    await op("records.delete", { id: ID });
    expect(sent.map((r) => r.path)).toContain(`${DNS}?comment.exact=${MARK}`);
    const [create, remove] = batches();
    expect(create).toEqual({
      posts: [DKIM, MX, SPF].map((record) => ({ ...record, ttl: 1, proxied: false, comment: MARK })),
      patches: [],
      deletes: [],
    });
    expect(remove).toEqual({
      posts: [],
      patches: [],
      deletes: [2, 3, 4].map((n) => ({ id: String(n).padStart(32, "0") })),
    });
  });

  it("updates a set in one batch: a changed record patched, one no longer declared deleted", async () => {
    play("records-update");
    await op("records.create", { desired });
    const spf = { ...SPF, content: "v=spf1 include:amazonses.com -all" };
    await op("records.update", {
      id: ID,
      desired: { ...desired, records: [MX, spf] },
      expect: { action: "update", replace: [] },
    });
    await op("records.delete", { id: ID });
    expect(batches()[1]).toEqual({
      posts: [],
      patches: [{ id: "00000000000000000000000000000004", ...spf, ttl: 1, proxied: false, comment: MARK }],
      deletes: [{ id: "00000000000000000000000000000002" }],
    });
  });

  it("adopts an unmarked record identical to a declared one, adding the mark", async () => {
    play("records-adopt");
    const made = await op("records.create", { desired });
    expect(batches()[0]).toEqual({
      posts: [DKIM, MX].map((record) => ({ ...record, ttl: 1, proxied: false, comment: MARK })),
      patches: [{ id: "00000000000000000000000000000005", ...SPF, ttl: 1, proxied: false, comment: MARK }],
      deletes: [],
    });
    expect(made.state.records).toHaveLength(3);
  });

  it("refuses a record beside an unmarked CNAME, naming it, before anything is written", async () => {
    play("records-conflict");
    await expect(op("records.create", { desired })).rejects.toMatchObject({
      retryable: false,
      vendorCode: "conflict",
      message: expect.stringContaining('CNAME check-send.sanoma.work "mail.example.net"'),
    });
    expect(batches()).toEqual([]);
  });

  it("refuses a second SPF policy at the name, and a record identical to another set's", async () => {
    const google = { type: "TXT", name: SPF.name, content: '"v=spf1 include:_spf.google.com ~all"' };
    play("records-spf-conflict", withOthers([unmarked(google)]));
    await expect(op("records.create", { desired })).rejects.toMatchObject({
      vendorCode: "conflict",
      message: expect.stringContaining("v=spf1 include:_spf.google.com"),
    });
    play("records-another-set", withOthers([unmarked(SPF, "sanoma:sanoma.work/other")]));
    await expect(op("records.create", { desired })).rejects.toMatchObject({
      vendorCode: "conflict",
      message: expect.stringContaining("another set's"),
    });
  });

  it("refuses a token without DNS Edit on the zone, naming the permission, whether the list or the batch is refused", async () => {
    const refusal = {
      retryable: false,
      status: 403,
      vendorCode: "no_dns_permission",
      message: expect.stringContaining("Zone → DNS → Edit on the zone sanoma.work"),
    };
    play("records-no-dns-permission");
    await expect(op("records.create", { desired })).rejects.toMatchObject(refusal);
    const [forbidden] = fixture("records-no-dns-permission").slice(-1);
    play("records-no-dns-edit", [
      ...fixture("records-create").slice(0, 4),
      { ...forbidden!, method: "POST", path: `${DNS}/batch` },
    ]);
    await expect(op("records.create", { desired })).rejects.toMatchObject(refusal);
  });

  it("refuses a zone the account does not hold, and reads a set there as gone", async () => {
    const [zones] = fixture("records-create");
    const none = cfList(zones!.path, []);
    play("records-no-zone", [none, none]);
    await expect(op("records.create", { desired })).rejects.toMatchObject({ vendorCode: "no_zone" });
    expect(await op("records.read", { id: ID })).toEqual({ id: ID, gone: true });
  });

  it("plans records not known yet: a create without a request, an update of a set the zone holds", async () => {
    expect(await op("records.plan", { desired: { ...desired, records: null } })).toEqual({
      action: "create",
      planned: { zone: "sanoma.work", name: "check", records: null },
      unknown: ["records", "zone_id", "record_ids"],
      replace: [],
    });
    expect(sent).toEqual([]);
    play("records-plan-unknown", fixture("records-read").slice(5, 7));
    expect(await op("records.plan", { id: ID, desired: { ...desired, records: null } })).toMatchObject({
      action: "update",
      planned: { zone_id: ZONE_ID, records: null, record_ids: null },
      unknown: ["records", "record_ids"],
    });
  });

  it("keeps what the zone holds when records are left out, and refuses records given as null", async () => {
    play("records-left-out", fixture("records-read").slice(5, 7));
    const kept = await op("records.update", { id: ID, desired: { zone: "sanoma.work", name: "check" } });
    expect(kept.state.records).toHaveLength(3);
    expect(batches()).toEqual([]);
    for (const name of ["records.create", "records.update"]) {
      await expect(op(name, { id: ID, desired: { ...desired, records: null } })).rejects.toMatchObject({
        retryable: false,
        vendorCode: "not_known",
      });
    }
  });
});

/** A record added to a zone by hand, without a set's mark. */
const hand = (record: object): ZoneRecord => ({ id: "by-hand", ttl: 1, ...record }) as ZoneRecord;

describe("cloudflare.records on the fake", () => {
  it("adopts an identical record added by hand, and never touches another one", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    const other = hand({
      id: "other",
      type: "TXT",
      name: "check-send.sanoma.work",
      content: "google-site-verification=x",
    });
    fake.state.dns["sanoma.work"] = [hand({ ...SPF, content: `"${SPF.content}"` }), other];
    const made = (await ops["records.create"]!({ desired }, callWith())) as Answer;
    expect(made.state.record_ids).toContain("by-hand");
    expect(fake.state.dns["sanoma.work"]!.find((r) => r.id === "by-hand")?.comment).toBe(MARK);
    await ops["records.delete"]!({ id: ID }, callWith());
    expect(fake.state.dns["sanoma.work"]).toEqual([other]);
  });

  it("refuses a CNAME in the way, and a zone the account does not hold", async () => {
    const fake = fakeCloudflare();
    fake.state.dns["sanoma.work"] = [
      hand({ type: "CNAME", name: "check-send.sanoma.work", content: "mail.example.net" }),
    ];
    await expect(fake.driver.ops["records.create"]!({ desired }, callWith())).rejects.toMatchObject({
      vendorCode: "conflict",
    });
    expect(fake.state.dns["sanoma.work"]).toHaveLength(1);
    const none = fakeCloudflare({ zones: [] });
    await expect(none.driver.ops["records.create"]!({ desired }, callWith())).rejects.toMatchObject({
      vendorCode: "no_zone",
    });
  });

  it("adopts the record a changed one would be patched to, deleting its own, and leaves an MX of another priority alone", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    await ops["records.create"]!({ desired }, callWith());
    const strict = { ...SPF, content: "v=spf1 include:amazonses.com -all" };
    const mx = { ...MX, priority: 5 };
    fake.state.dns["sanoma.work"]!.push(hand(strict), hand({ ...mx, id: "mx-by-hand" }));
    const changed = (await ops["records.update"]!(
      { id: ID, desired: { ...desired, records: [DKIM, MX, strict] } },
      callWith(),
    )) as Answer;
    expect(changed.state.record_ids).toContain("by-hand");
    const zone = fake.state.dns["sanoma.work"]!;
    expect(zone.filter((r) => r.type === "TXT" && r.name === SPF.name).map((r) => r.content)).toEqual([strict.content]);
    expect(zone.find((r) => r.id === "mx-by-hand")).toMatchObject({ priority: 5 });
    expect(zone.find((r) => r.id === "mx-by-hand")?.comment).toBeUndefined();
  });

  it("compares a CAA record's value quoted or not, and refuses an empty set or a record declared twice", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    const caa = { type: "CAA", name: "sanoma.work", content: "0 issue letsencrypt.org" };
    const made = (await ops["records.create"]!({ desired: { ...desired, records: [caa] } }, callWith())) as Answer;
    expect(made.state.records).toEqual([{ ...caa, content: '0 issue "letsencrypt.org"', ttl: 1 }]);
    expect(await ops["records.plan"]!({ id: ID, desired: { ...desired, records: [caa] } }, callWith())).toMatchObject({
      action: "none",
    });
    for (const records of [[], [SPF, { ...SPF, ttl: 300 }]]) {
      await expect(ops["records.plan"]!({ desired: { ...desired, records } }, callWith())).rejects.toMatchObject({
        vendorCode: "invalid",
      });
    }
  });

  it("writes a batch all or nothing: one a record added by hand since the set's look fails is not kept", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    await ops["records.create"]!({ desired }, callWith());
    let zone = fake.state.dns["sanoma.work"]!;
    const before = structuredClone(zone);
    const cname = hand({ type: "CNAME", name: "check-new.sanoma.work", content: "mail.example.net" });
    // The zone read by the set's look, its two names' lookups, then the batch: the CNAME is there by then.
    let reads = 0;
    Object.defineProperty(fake.state.dns, "sanoma.work", {
      get: () => (++reads > 3 ? [...zone, cname] : zone),
      set: (next: ZoneRecord[]) => (zone = next),
      enumerable: true,
    });
    const strict = { ...SPF, content: "v=spf1 include:amazonses.com -all" };
    const added = { type: "TXT", name: "check-new.sanoma.work", content: "token" };
    await expect(
      ops["records.update"]!({ id: ID, desired: { ...desired, records: [DKIM, MX, strict, added] } }, callWith()),
    ).rejects.toMatchObject({ status: 400 });
    expect(zone).toEqual(before);
  });

  it("refuses a record outside the zone, a CNAME beside another declared record, and a mark too long for a comment", async () => {
    const ops = fakeCloudflare().driver.ops;
    const cname = { type: "CNAME", name: SPF.name, content: "mail.example.net" };
    for (const plan of [
      { desired: { ...desired, records: [{ ...SPF, name: "check-send.example.com" }] } },
      { desired: { ...desired, records: [SPF, cname] } },
      { desired: { zone: `${"z".repeat(60)}.example.com`, name: "a".repeat(40), records: [] } },
    ]) {
      await expect(ops["records.plan"]!(plan, callWith())).rejects.toMatchObject({ vendorCode: "invalid" });
      await expect(ops["records.create"]!(plan, callWith())).rejects.toMatchObject({ vendorCode: "invalid" });
    }
  });

  it("refuses to adopt a proxied record, to patch a record beside another SPF policy, and an MX to the same server at another priority", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    fake.state.dns["sanoma.work"] = [hand({ ...SPF, proxied: true })];
    await expect(ops["records.create"]!({ desired }, callWith())).rejects.toMatchObject({
      vendorCode: "conflict",
      message: expect.stringContaining("proxied"),
    });
    fake.state.dns["sanoma.work"] = [];
    await ops["records.create"]!({ desired }, callWith());
    const google = hand({ type: "TXT", name: SPF.name, content: "v=spf1 include:_spf.google.com ~all" });
    fake.state.dns["sanoma.work"]!.push(google);
    const strict = { ...SPF, content: "v=spf1 include:amazonses.com -all" };
    await expect(
      ops["records.update"]!({ id: ID, desired: { ...desired, records: [DKIM, MX, strict] } }, callWith()),
    ).rejects.toMatchObject({ vendorCode: "conflict", message: expect.stringContaining("_spf.google.com") });
    fake.state.dns["sanoma.work"] = fake.state.dns["sanoma.work"]!.filter((r) => r !== google);
    fake.state.dns["sanoma.work"]!.push(hand({ ...MX, name: "check-in.sanoma.work", priority: 5 }));
    await expect(
      ops["records.update"]!(
        { id: ID, desired: { ...desired, records: [DKIM, MX, SPF, { ...MX, name: "check-in.sanoma.work" }] } },
        callWith(),
      ),
    ).rejects.toMatchObject({ vendorCode: "conflict", message: expect.stringContaining("check-in.sanoma.work") });
  });

  it("patches a record whose ttl changed in place, beside one of its type and name whose content changed", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    const token = { type: "TXT", name: SPF.name, content: "site-verification=x" };
    await ops["records.create"]!({ desired: { ...desired, records: [SPF, token] } }, callWith());
    const idOf = (content: string) => fake.state.dns["sanoma.work"]!.find((r) => r.content === content)?.id;
    const [spfId, tokenId] = [idOf(SPF.content), idOf(token.content)];
    const strict = { ...SPF, content: "v=spf1 include:amazonses.com -all" };
    await ops["records.update"]!(
      { id: ID, desired: { ...desired, records: [{ ...token, ttl: 300 }, strict] } },
      callWith(),
    );
    expect(fake.state.dns["sanoma.work"]!.find((r) => r.id === tokenId)).toMatchObject({ ...token, ttl: 300 });
    expect(fake.state.dns["sanoma.work"]!.find((r) => r.id === spfId)).toMatchObject(strict);
  });

  it("plans a replace of records not known yet with them unknown, and takes a retried update found done as done", async () => {
    const fake = fakeCloudflare();
    const ops = fake.driver.ops;
    await ops["records.create"]!({ desired }, callWith());
    expect(
      await ops["records.plan"]!({ id: ID, desired: { ...desired, name: "other", records: null } }, callWith()),
    ).toMatchObject({ action: "replace", unknown: ["records", "zone_id", "record_ids"], replace: ["name"] });
    const update = {
      id: ID,
      desired: { ...desired, records: [DKIM, MX] },
      expect: { action: "update", replace: [] },
    };
    await ops["records.update"]!(update, callWith());
    const again = (await ops["records.update"]!(update, callWith())) as Answer;
    expect(again.state.records).toHaveLength(2);
  });
});
