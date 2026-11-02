import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import {
  type ApplyReport,
  type PlanAction,
  defineConnector,
  defineResource,
  type DnsRecord,
  dnsRecord,
  memoryLedger,
  type Source,
  withSetup,
} from "@sanoma-ai/workflows";
import { defineFake } from "@sanoma-ai/workflows/fake";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeCloudflare } from "../src/fake.ts";
import { cloudflare } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. A data file declares a sending domain and the record set that
// takes its DNS records (`records: mail`), as sanoma-ops's `infra.ts` will; apply and drift run
// over the Cloudflare fake and a toy `resend.domain` made here (the Resend connector's own is
// another lane's), whose state lists the records it asks for in `dns_records`.

const recordsOf = (key: string): DnsRecord[] => [
  { type: "TXT", name: "resend._domainkey.sanoma.work", content: `p=${key}` },
  { type: "MX", name: "send.sanoma.work", content: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { type: "TXT", name: "send.sanoma.work", content: "v=spf1 include:amazonses.com ~all" },
];

const domain = defineResource({
  vendor: "resend",
  type: "domain",
  title: "Domain",
  identity: "name",
  schema: z.object({ name: z.string(), dns_records: z.array(dnsRecord).nullish() }),
  fields: { immutable: ["name"], vendorOwned: ["dns_records"], writeOnly: [] },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
});
// Only what the data file imports it from: no such package is published.
const resendTypes = defineConnector("resend", { domain }, { title: "Resend", package: "@sanoma-ai/testing-resend" });

/** A plan's answer. */
const answer = (action: PlanAction, planned?: Record<string, unknown>, unknown: string[] = []) => ({
  action,
  ...(planned && { planned }),
  unknown,
  replace: [],
});

/** The toy domain's fake: each domain's records made from its DKIM key, `key`, which a test rotates. */
const resend = defineFake(resendTypes, {
  initial: () => ({ key: "first", domains: new Map<string, { name: string; dns_records: DnsRecord[] }>() }),
  ops: (state) => {
    const read = async ({ id }: { id: string }) => {
      const found = state.domains.get(id);
      return found ? { id, gone: false, state: found } : { id, gone: true };
    };
    const put = async ({ desired }: { desired: Record<string, unknown> }) => {
      const made = { name: String(desired.name), dns_records: recordsOf(state.key) };
      state.domains.set(made.name, made);
      return { id: made.name, state: made };
    };
    return {
      domain: {
        import: read,
        read,
        plan: async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }) => {
          const held = id === undefined ? undefined : state.domains.get(id);
          if (!desired) return answer(held ? "delete" : "none");
          if (!held) return answer("create", { ...desired, dns_records: null }, ["dns_records"]);
          const next = recordsOf(state.key);
          if (JSON.stringify(next) === JSON.stringify(held.dns_records)) return answer("none", held);
          return answer("update", { ...held, dns_records: next });
        },
        create: put,
        update: put,
        delete: async ({ id }: { id: string }) => {
          state.domains.delete(id);
          return { id, gone: true as const };
        },
      },
    };
  },
});

const root = mkdtempSync(join(tmpdir(), "sanoma-cloudflare-records-"));
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cloudflare-records", type: "module" }));
mkdirSync(join(root, "resources"));
writeFileSync(
  join(root, "resources", "mail.ts"),
  [
    'import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";',
    'import { resend } from "@sanoma-ai/testing-resend/resources";',
    "",
    'export const mail = resend.domain({ name: "sanoma.work" });',
    'export const mailDns = cloudflare.records({ zone: "sanoma.work", name: "resend", records: mail });',
    "",
  ].join("\n"),
);
let commits = 0;
const source: Source = { root, commit: () => ({ revision: `rev${++commits}` }), head: () => `rev${commits}` };

const cf = fakeCloudflare();
const MARK = "sanoma:sanoma.work/resend";
const marked = () =>
  (cf.state.dns["sanoma.work"] ?? [])
    .filter((r) => r.comment === MARK)
    .map(({ type, name, content }) => ({ type, name, content }));
const actions = (report: ApplyReport) => report.plan.steps.map((s) => [s.id, s.action]);

describe("cloudflare.records taking a sending domain's records", () => {
  const app = useTestApp(
    {
      workflows: [],
      connectors: [withFake(resendTypes, resend), withSetup(cloudflare, { driver: () => cf.driver })],
      root,
      ledger: memoryLedger(),
    },
    { databaseUrl: testDatabaseUrl("cloudflare_records"), source },
  );
  const by = { startedBy: { id: "ops" } };
  const apply = async () => app.client.applyReport(await app.client.apply({}, by));
  const drift = async () => app.client.driftReport(await app.client.drift(by));

  afterAll(async () => {
    await cf.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the domain, then its records, planned unknown; finds both as declared; writes a rotated key", async () => {
    const first = await apply();
    expect(actions(first)).toEqual([
      ["resources/mail.ts#mail", "create"],
      ["resources/mail.ts#mailDns", "create"],
    ]);
    expect(first.plan.steps[1]).toMatchObject({
      planned: { records: null },
      unknown: ["records", "zone_id", "record_ids"],
    });
    expect(first.results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(marked()).toEqual(recordsOf("first").map(({ type, name, content }) => ({ type, name, content })));

    expect(actions(await apply())).toEqual([
      ["resources/mail.ts#mail", "none"],
      ["resources/mail.ts#mailDns", "none"],
    ]);
    expect((await drift()).resources.map((r) => r.status)).toEqual(["clean", "clean"]);

    // The domain asks for a new DKIM key: the set drifts, and the next apply patches it.
    resend.update((state) => {
      state.key = "second";
      state.domains.set("sanoma.work", { name: "sanoma.work", dns_records: recordsOf("second") });
    });
    const drifted = (await drift()).resources[1]!;
    expect(drifted).toMatchObject({ status: "drifted" });
    const again = await apply();
    expect(actions(again)).toEqual([
      ["resources/mail.ts#mail", "none"],
      ["resources/mail.ts#mailDns", "update"],
    ]);
    expect(again.results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(marked()).toContainEqual({ type: "TXT", name: "resend._domainkey.sanoma.work", content: "p=second" });
    expect(marked()).toHaveLength(3);
  });
});
