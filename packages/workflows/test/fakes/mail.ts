import { withFake } from "@sanoma-ai/testing";
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

// Two toy types, for a field one takes from another's state (`FieldReference.from`): a sending
// domain whose state lists the DNS records it asks for, and a record set that writes them, its
// `records` taken from a domain's `records`. Both kept in memory by name.

const domainSchema = z.object({ name: z.string(), records: z.array(dnsRecord).nullish() });
const recordsSchema = z.object({ name: z.string(), records: z.array(dnsRecord) });

/** `mail.domain`: a sending domain, whose state lists the records it asks for. */
export const domain = defineResource({
  vendor: "mail",
  type: "domain",
  title: "Domain",
  identity: "name",
  schema: domainSchema,
  fields: { immutable: ["name"], vendorOwned: ["records"], writeOnly: [] },
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

const mailTypes = defineConnector(
  "mail",
  { domain, records },
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

/** A `delete` from `store()`, by name. */
const remover =
  (store: () => Map<string, unknown>) =>
  async ({ id }: { id: string }) => {
    store().delete(id);
    return { id, gone: true as const };
  };

/**
 * The fake (`defineFake`): its state holds `domains` and `sets` by name, and `connector` is the
 * connector that live runs call it through. A record set refuses records it is given as `null`,
 * as a real one does (`not_known`).
 */
export function fakeMail() {
  const fake = defineFake(mailTypes, {
    initial: () => ({
      domains: new Map<string, z.output<typeof domainSchema>>(),
      sets: new Map<string, z.output<typeof recordsSchema>>(),
    }),
    ops: (state) => {
      const domains = () => state.domains;
      const sets = () => state.sets;
      const putSet = async ({ desired }: { desired: State }) => {
        if (desired.records === null)
          throw new DriverError("mail: records are not known yet", { retryable: false, vendorCode: "not_known" });
        const made = recordsSchema.parse(desired);
        sets().set(made.name, made);
        return { id: made.name, state: made };
      };
      return {
        domain: {
          import: reader(domains),
          read: reader(domains),
          // Its name cannot change, and its records are the vendor's, made at create.
          plan: async ({ id, desired }): Promise<Plan> => {
            const held = id === undefined ? undefined : domains().get(id);
            if (!desired) return { action: held ? "delete" : "none", unknown: [], replace: [] };
            if (held) return { action: "none", planned: held, unknown: [], replace: [] };
            return { action: "create", planned: { ...desired, records: null }, unknown: ["records"], replace: [] };
          },
          create: async ({ desired }) => {
            const made = { name: String(desired.name), records: recordsFor(String(desired.name)) };
            domains().set(made.name, made);
            return { id: made.name, state: made };
          },
          // A writable type's driver has every change operation; a domain's plan never asks for this one.
          update: async ({ id }) => ({ id, state: domains().get(id)! }),
          delete: remover(domains),
        },
        records: {
          import: reader(sets),
          read: reader(sets),
          plan: async ({ id, desired }): Promise<Plan> => {
            const held = id === undefined ? undefined : sets().get(id);
            if (!desired) return { action: held ? "delete" : "none", unknown: [], replace: [] };
            // A field given as `null` is known only after apply.
            const unknown = Object.keys(desired).filter((field) => desired[field] === null);
            if (!held) return { action: "create", planned: desired, unknown, replace: [] };
            const same = JSON.stringify(desired.records) === JSON.stringify(held.records);
            return { action: same ? "none" : "update", planned: { ...held, ...desired }, unknown, replace: [] };
          },
          create: putSet,
          update: putSet,
          delete: remover(sets),
        },
      };
    },
  });
  return Object.assign(fake, { connector: withFake(mailTypes, fake) });
}
