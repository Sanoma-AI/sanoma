import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { beforeEach, describe, expect, it } from "vitest";
import { describeConfig } from "../src/describe.ts";
import { byCodePoint, importEntry, importRows, mappingProblems } from "../src/import.ts";
import { type LedgerRecord, resolveConfig, type SanomaConfig } from "../src/index.ts";
import { IMPORT_WORKFLOW, type ImportInput } from "../src/shared.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import { failure, rootWith, waitFor } from "./harness.ts";

// Needs Postgres (`pnpm db:up`) for the runs. The built-in `import`: a sheet's rows read as the
// collection's fields take them (`import.ts`), then a run that adds and updates the records,
// leaving what the fields refuse, what the policy denies, and holding a batch the policy holds.

/** Company, Contact, Status, Rep, Last contact, Seats: the outbound fixture's fields, in a sheet's words. */
const mapping: ImportInput["mapping"] = [
  { field: "company" },
  { field: "contact" },
  { field: "stage", values: { "In talks": "meeting", Signed: "won" } },
  { field: "owner", values: { "Ada Lovelace": "ada" } },
  { field: "lastTouched" },
  { field: "seats" },
];
const people = ["ada", "lead"];
const row = (company: string, stage = "researched", more: string[] = []) => [
  company,
  `${company.toLowerCase()}@example.test`,
  stage,
  "ada",
  ...more,
];

/** A record as `list` answers it, with the issues its fields find. */
const saved = (record: Record<string, unknown>, issues?: { path: string[]; message: string }[]) => ({
  key: String(record.company),
  record,
  updatedAt: "2026-11-01T00:00:00Z",
  updatedBy: "ada",
  ...(issues && { issues }),
});

describe("importRows and importEntry", () => {
  it("reads each cell as its field's type, through its column's values, and leaves the rows the fields refuse", () => {
    const { rows, problems } = importRows(outbound, {
      mapping,
      people,
      rows: [
        ["  Acme ", "a@acme.test", "In talks", "Ada Lovelace", "2026-11-01", "12"],
        ["Globex", "", "contacted", "lead", "2026-11-01T09:30:00+02:00", ""],
        ["Hooli", "h@hooli.test", "talking", "T. Nguyen", "11/01/2026", "ten"],
        ["", "x@nobody.test", "lead", "ada"],
        ["Acme", "again@acme.test", "won", "ada"],
        [" ", "", ""],
        ["Hooli", "h@hooli.test", "won", "ada"],
        ["Initech", "i@initech.test", "constructor", "ada"],
      ],
    });
    expect(rows).toEqual([
      {
        row: 2,
        key: "Acme",
        fields: {
          company: "Acme",
          contact: "a@acme.test",
          stage: "meeting",
          owner: "ada",
          lastTouched: "2026-11-01",
          seats: 12,
        },
      },
      // An empty cell fills nothing: an update keeps the record's own.
      {
        row: 3,
        key: "Globex",
        fields: { company: "Globex", stage: "contacted", owner: "lead", lastTouched: "2026-11-01T09:30:00+02:00" },
      },
      // A blank row is skipped, keeping its number; a key a refused row had is the corrected row's.
      { row: 8, key: "Hooli", fields: { company: "Hooli", contact: "h@hooli.test", stage: "won", owner: "ada" } },
    ]);
    expect(problems).toEqual([
      {
        row: 4,
        key: "Hooli",
        reason:
          'stage: "talking" is not one of researched, contacted, replied, meeting, won, lost; ' +
          'owner: "T. Nguyen" is nobody declared; lastTouched: "11/01/2026" is not a date as 2026-11-01 writes one; ' +
          'seats: "ten" is not a number',
      },
      {
        row: 5,
        reason: 'no company, the key; stage: "lead" is not one of researched, contacted, replied, meeting, won, lost',
      },
      { row: 6, key: "Acme", reason: 'company "Acme" is row 2\'s too' },
      // A column's values are its own: not the prototype's.
      {
        row: 9,
        key: "Initech",
        reason: 'stage: "constructor" is not one of researched, contacted, replied, meeting, won, lost',
      },
    ]);
  });

  it("takes any id for a person while nobody is declared", () => {
    for (const declared of [undefined, []]) {
      const { rows } = importRows(outbound, { mapping, people: declared, rows: [row("Acme").with(3, "T. Nguyen")] });
      expect(rows.map((r) => r.fields.owner)).toEqual(["T. Nguyen"]);
    }
  });

  it("takes a date as the collection's schema does, no more", () => {
    const dates = [
      "2026-11-01",
      "2028-02-29",
      "0050-01-01",
      "2026-02-30",
      "2026-11-01T10:00:00Z",
      "2026-11-01T10:00:00.5-07:00",
      "2026-11-01T10:00Z",
      "2026-11-01T10:00:00",
      "2026-11-01T24:00:00Z",
      "2026-11-01T10:00:00+0200",
    ];
    for (const date of dates) {
      const { rows } = importRows(outbound, { mapping, rows: [["Acme", "a", "won", "ada", date]] });
      const record = { company: "Acme", contact: "a", stage: "won", owner: "ada", lastTouched: date };
      expect([date, rows.length === 1]).toEqual([date, outbound.save.input.safeParse({ record }).success]);
    }
  });

  it("adds a new key, updates the fields a row fills over the record's others, and asks for what a new record lacks", () => {
    const [acme, globex] = importRows(outbound, { mapping, rows: [row("Acme"), ["Globex", "", "won"]] }).rows;
    const there = { company: "Acme", contact: "acme@example.test", stage: "researched", owner: "ada", seats: 3 };
    expect(importEntry(outbound, acme!, undefined)).toEqual({ will: "add", record: acme!.fields });
    expect(importEntry(outbound, acme!, saved(there))).toEqual({ will: "keep" });
    expect(importEntry(outbound, acme!, saved({ ...there, stage: "replied" }))).toEqual({
      will: "update",
      record: there,
      was: { ...there, stage: "replied" },
    });
    expect(importEntry(outbound, globex!, undefined)).toEqual({ will: "fix", reason: "needs contact, owner" });
    // A record the fields refuse now is fixed first, unless the row replaces what they refuse.
    const stale = saved({ ...there, stage: "dormant" }, [{ path: ["stage"], message: "Invalid option" }]);
    expect(importEntry(outbound, acme!, stale)).toMatchObject({ will: "update" });
    expect(importEntry(outbound, { ...acme!, fields: { company: "Acme" } }, stale)).toEqual({
      will: "fix",
      reason: "the record's stage the fields refuse: fix it first",
    });
  });

  it("names a mapping's wrong columns, which importRows refuses", () => {
    expect(mappingProblems(outbound, [{ field: "stage" }, { field: "stage" }, { field: "phone" }, null])).toEqual([
      "Two columns fill stage",
      "There is no field phone",
      "No column fills company, the key",
    ]);
    expect(() => importRows(outbound, { mapping: [{ field: "phone" }], rows: [] })).toThrow(/There is no field phone/);
  });

  it("orders keys by code point, as Postgres's C collation does", () => {
    expect(["b", "\u{1F600}", "a", "Ａ", "ab"].toSorted(byCodePoint)).toEqual(["a", "ab", "b", "Ａ", "\u{1F600}"]);
  });
});

/** Allows, but denies a lead `lost` and holds one `won` for `lead`, as the app's fixture does. */
const root = rootWith({
  "policies/policy.cedar": `@reason("leads are not lost")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "lost" };

@hold("lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource)
when { context.input.record.stage == "won" };
`,
  "resources/people.ts": `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const lead = sanoma.person({ id: "lead" });
`,
});
const config: SanomaConfig = { workflows: [], connectors: [], collections: [outbound], root };

describe("the built-in import", () => {
  const app = useTestApp(config, { databaseUrl: testDatabaseUrl("import") });
  const ada = { id: "ada" };
  const call = (op: string, input: unknown) => app.client.call(op, input, { actor: ada, id: randomUUID() });
  const keys = async () =>
    ((await call("data.outbound.list", { limit: 1000 })) as { key: string; record: Record<string, unknown> }[]).map(
      ({ key, record }) => [key, record.stage],
    );
  const start = (rows: string[][]) =>
    app.client.start(IMPORT_WORKFLOW, { collection: "outbound", mapping, rows, people }, { startedBy: ada });
  const called = async (runId: string) =>
    (await app.client.ledger(runId)).flatMap((r: LedgerRecord) => (r.type === "op.called" ? [r] : []));

  beforeEach(async () => {
    for (const [key] of await keys()) await call("data.outbound.delete", { key });
    for (const company of ["Globex", "Initech"]) {
      const [, contact, stage, owner] = row(company, "contacted");
      await call("data.outbound.save", { record: { company, contact, stage, owner } });
    }
  });

  it("is built in when the config has a collection, its outline over each collection's list and saveMany", () => {
    const resolved = resolveConfig(config);
    expect(resolved.workflows.get(IMPORT_WORKFLOW)?.uses.map((op: { id: string }) => op.id)).toEqual([
      "data.outbound.list",
      "data.outbound.saveMany",
    ]);
    expect(resolveConfig({ ...config, collections: [] }).workflows.has(IMPORT_WORKFLOW)).toBe(false);
    const entry = describeConfig(config).workflows.find((wf) => wf.name === IMPORT_WORKFLOW)!;
    expect(entry).toMatchObject({ builtin: true, title: "Import a spreadsheet" });
    expect(JSON.stringify(entry.outline)).not.toContain("error");
  });

  it("adds new keys, updates those there, leaves the rows the fields refuse and the entries the policy denies", async () => {
    const runId = await start([
      row("Acme", "In talks"),
      row("Globex", "replied"),
      row("Initech", "contacted"),
      row("Lost Co", "lost"),
      row("Hooli", "researched", ["", "ten"]),
      [...row("Pied Piper").slice(0, 3), "T. Nguyen"],
      // Denied too, and its key ends another's: each denied key has its own reason.
      row("t Co", "lost"),
    ]);
    expect(await app.client.result(runId)).toEqual({
      added: 1,
      updated: 1,
      unchanged: 1,
      problems: [
        { row: 5, key: "Lost Co", reason: "the policy denies saving it: leads are not lost" },
        { row: 6, key: "Hooli", reason: 'seats: "ten" is not a number' },
        { row: 7, key: "Pied Piper", reason: 'owner: "T. Nguyen" is nobody declared' },
        { row: 8, key: "t Co", reason: "the policy denies saving it: leads are not lost" },
      ],
    });
    expect(await keys()).toEqual([
      ["Acme", "meeting"],
      ["Globex", "replied"],
      ["Initech", "contacted"],
    ]);
    // One read of the batch's keys, its save denied whole for Lost Co and t Co, then saved without them; each
    // entry decided and recorded as the collection's save, the new one with ifAbsent.
    const made = await called(runId);
    expect(made.map(({ op, target, decision }) => [op, target, decision.kind])).toEqual([
      ["data.outbound.list", "data:outbound", "allow"],
      ["data.outbound.save", "data:outbound/Acme", "allow"],
      ["data.outbound.save", "data:outbound/Globex", "allow"],
      ["data.outbound.save", "data:outbound/Lost Co", "deny"],
      ["data.outbound.save", "data:outbound/t Co", "deny"],
      ["data.outbound.save", "data:outbound/Acme", "allow"],
      ["data.outbound.save", "data:outbound/Globex", "allow"],
    ]);
    expect(made.at(-2)!.input).toMatchObject({ ifAbsent: true });
    expect(made.at(-1)!.input).toMatchObject({ ifRecord: { stage: "contacted" } });
  });

  it("holds a batch the policy holds, saving it once approved", async () => {
    const runId = await start([row("Acme", "Signed"), row("Globex")]);
    await waitFor(async () => (await app.client.approvals(runId)).some((a) => a.status === "pending"));
    expect(await keys()).toEqual([
      ["Globex", "contacted"],
      ["Initech", "contacted"],
    ]);
    expect(await app.client.approvals(runId)).toMatchObject([
      { op: "data.outbound.saveMany", covers: ["data.outbound.saveMany", "data.outbound.save"], approver: "lead" },
    ]);
    await app.client.decide(runId, { decision: "approve", by: { id: "lead" } });
    expect(await app.client.result(runId)).toEqual({ added: 1, updated: 1, unchanged: 0, problems: [] });
    expect(await keys()).toEqual([
      ["Acme", "won"],
      ["Globex", "researched"],
      ["Initech", "contacted"],
    ]);
  });

  it("refuses at the start a collection the config lacks, or columns its fields do not take", async () => {
    await expect(
      failure(app.client.start(IMPORT_WORKFLOW, { collection: "leads", mapping, rows: [] }, { startedBy: ada })),
    ).resolves.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("There is no collection leads"),
    });
    await expect(
      failure(
        app.client.start(
          IMPORT_WORKFLOW,
          { collection: "outbound", mapping: [{ field: "stage" }], rows: [] },
          { startedBy: ada },
        ),
      ),
    ).resolves.toMatchObject({ code: "invalid_input", message: expect.stringContaining("No column fills company") });
  });
});
