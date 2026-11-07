import { withFake } from "sanoma/testing";
import { z } from "zod";
import { defineFake } from "../../src/fake.ts";
import {
  defineConnector,
  defineResource,
  type DnsRecord,
  dnsRecord,
  DriverError,
  type PlanAction,
} from "../../src/index.ts";

// Toy types, for a field one takes from another's state (`FieldReference.from`): a sending
// domain whose state lists the DNS records it asks for, a record set that writes them, its
// `records` taken from a domain's `records`, and a copy of a record set's, for a chain. All kept
// in memory by name.

const domainSchema = z.object({
  name: z.string(),
  records: z.array(dnsRecord).nullish(),
  /** False while the vendor asks for it to be checked again, which changes nothing else. */
  verified: z.boolean().optional(),
});
const recordsSchema = z.object({ name: z.string(), label: z.string().optional(), records: z.array(dnsRecord) });

/** `mail.domain`: a sending domain, whose state lists the records it asks for. */
export const domain = defineResource({
  vendor: "mail",
  type: "domain",
  title: "Domain",
  identity: "name",
  schema: domainSchema,
  fields: { immutable: ["name"], vendorOwned: ["records", "verified"], writeOnly: [] },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
});

/** `mail.records`: a record set, its `records` taken from a `mail.domain`'s (`from`). */
export const records = defineResource({
  vendor: "mail",
  type: "records",
  title: "Records",
  identity: "name",
  schema: recordsSchema,
  fields: {
    immutable: [],
    vendorOwned: [],
    writeOnly: [],
    unordered: ["records"],
    references: { records: { type: "mail.domain", from: "records" } },
  },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
});

/** `mail.copy`: a record set, its `records` taken from a `mail.records`' (`from`): a chain's third. */
export const copy = defineResource({
  vendor: "mail",
  type: "copy",
  title: "Copy",
  identity: "name",
  schema: recordsSchema,
  fields: {
    immutable: [],
    vendorOwned: [],
    writeOnly: [],
    unordered: ["records"],
    references: { records: { type: "mail.records", from: "records" } },
  },
  find: ({ name }) => name,
  bindingId: (state) => String(state.name),
  writable: true,
});

const mailTypes = defineConnector(
  "mail",
  { domain, records, copy },
  // Only what a data file imports it from: no such package is published.
  { title: "Mail", package: "@sanoma-ai/testing-mail" },
);

/** A data file declaring `sending`, a domain, and `dns`, its records: `resources/mail.ts`. */
export const mailDataFile = [
  'import { mail } from "@sanoma-ai/testing-mail/resources";',
  "",
  'export const sending = mail.domain({ name: "example.com" });',
  'export const dns = mail.records({ name: "example.com/mail", records: sending });',
  "",
].join("\n");

/** `mailDataFile` and `copy`, a copy of `dns`'s records: a chain of three. */
export const chainDataFile = `${mailDataFile}export const copy = mail.copy({ name: "example.com/copy", records: dns });\n`;

/** The records a domain asks for: a DKIM key and a bounce MX, by its name. */
export const recordsFor = (name: string): DnsRecord[] => [
  { type: "TXT", name: `mail._domainkey.${name}`, content: `p=${name}` },
  { type: "MX", name: `send.${name}`, content: "feedback.example.com", priority: 10 },
];

type State = Record<string, unknown>;
type Plan = { action: PlanAction; planned?: State; unknown: string[]; replace: string[] };

/** An `import` or `read` of what `store()` holds by name: read at each call, as `reset` replaces the maps. */
const reader =
  <T extends State>(store: () => Map<string, T>) =>
  async ({ id }: { id: string }) => {
    const state = store().get(id);
    return state ? { id, gone: false, state } : { id, gone: true };
  };

/**
 * An `update` that plans again first, as a real driver does, and refuses (`plan_changed`) when
 * the plan no longer matches what was approved (`expect`).
 */
const expecting =
  <T>(
    plan: (input: { id: string; desired: State }) => Promise<Plan>,
    put: (input: { id: string; desired: State }) => Promise<T>,
  ) =>
  async (input: { id: string; desired: State; expect?: { action: PlanAction; replace: string[] } }) => {
    const fresh = await plan(input);
    const { expect } = input;
    if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join()))
      throw new DriverError(`mail: ${input.id} now plans ${fresh.action}, not ${expect.action}`, {
        retryable: false,
        vendorCode: "plan_changed",
      });
    return put(input);
  };

/**
 * A record set's operations on `store()`: it writes the fields it is given over what it holds (a
 * field left out is kept), refuses records given as `null` (`not_known`), and is replaced when a
 * record it holds is dropped.
 */
function recordSet(store: () => Map<string, z.output<typeof recordsSchema>>) {
  const put = async ({ desired }: { desired: State }) => {
    if (desired.records === null)
      throw new DriverError("mail: records are not known yet", { retryable: false, vendorCode: "not_known" });
    const made = recordsSchema.parse({ ...store().get(String(desired.name)), ...desired });
    store().set(made.name, made);
    return { id: made.name, state: made };
  };
  const plan = async ({ id, desired }: { id?: string; desired?: State }): Promise<Plan> => {
    const held = id === undefined ? undefined : store().get(id);
    if (!desired) return { action: held ? "delete" : "none", unknown: [], replace: [] };
    // A field given as `null` is known only after apply.
    const unknown = Object.keys(desired).filter((field) => desired[field] === null);
    if (!held) return { action: "create", planned: desired, unknown, replace: [] };
    // Declared fields only: records left out (not known yet) are no change.
    const same = Object.entries(desired).every(
      ([field, value]) => JSON.stringify(value) === JSON.stringify(held[field as keyof typeof held]),
    );
    // Records are added in place; one dropped replaces the set.
    const kept = new Set((Array.isArray(desired.records) ? desired.records : []).map((r) => JSON.stringify(r)));
    const drops = Array.isArray(desired.records) && held.records.some((r) => !kept.has(JSON.stringify(r)));
    if (drops) return { action: "replace", planned: { ...held, ...desired }, unknown, replace: ["records"] };
    return { action: same ? "none" : "update", planned: { ...held, ...desired }, unknown, replace: [] };
  };
  return {
    import: reader(store),
    read: reader(store),
    plan,
    create: put,
    update: expecting(plan, put),
    delete: remover(store),
  };
}

/** A `delete` from `store()`, by name. */
const remover =
  (store: () => Map<string, unknown>) =>
  async ({ id }: { id: string }) => {
    store().delete(id);
    return { id, gone: true as const };
  };

/**
 * The fake (`defineFake`): its state holds `domains`, `sets` and `copies` by name, and `connector`
 * is the connector that live runs call it through. A record set refuses records it is given as
 * `null`, as a real one does (`not_known`), and an update refuses a plan that changed
 * (`plan_changed`).
 */
export function fakeMail() {
  const fake = defineFake(mailTypes, {
    initial: () => ({
      domains: new Map<string, z.output<typeof domainSchema>>(),
      sets: new Map<string, z.output<typeof recordsSchema>>(),
      copies: new Map<string, z.output<typeof recordsSchema>>(),
    }),
    ops: (state) => {
      const domains = () => state.domains;
      // Its name cannot change, and its records are the vendor's, made at create. One that lists
      // none yet (pending), lists others (a key rotated) or is to be verified again (no record
      // changes) is updated, which lists them.
      const planDomain = async ({ id, desired }: { id?: string; desired?: State }): Promise<Plan> => {
        const held = id === undefined ? undefined : domains().get(id);
        if (!desired) return { action: held ? "delete" : "none", unknown: [], replace: [] };
        if (held?.records == null && held)
          return { action: "update", planned: { ...held, records: null }, unknown: ["records"], replace: [] };
        if (held && JSON.stringify(held.records) !== JSON.stringify(recordsFor(held.name)))
          return { action: "update", planned: { ...held, records: recordsFor(held.name) }, unknown: [], replace: [] };
        if (held?.verified === false)
          return { action: "update", planned: { ...held, verified: true }, unknown: [], replace: [] };
        if (held) return { action: "none", planned: held, unknown: [], replace: [] };
        return { action: "create", planned: { ...desired, records: null }, unknown: ["records"], replace: [] };
      };
      return {
        domain: {
          import: reader(domains),
          read: reader(domains),
          plan: planDomain,
          create: async ({ desired }) => {
            const made = { name: String(desired.name), records: recordsFor(String(desired.name)) };
            domains().set(made.name, made);
            return { id: made.name, state: made };
          },
          update: expecting(planDomain, async ({ id }) => {
            const made = { name: id, records: recordsFor(id) };
            domains().set(id, made);
            return { id, state: made };
          }),
          delete: remover(domains),
        },
        records: recordSet(() => state.sets),
        copy: recordSet(() => state.copies),
      };
    },
  });
  return Object.assign(fake, { connector: withFake(mailTypes, fake) });
}
