import { diffDeclared, type DnsRecord, dnsRecord, DriverError, errorMessage, type PlanAction } from "sanoma/workflows";
import type { z } from "zod";
import {
  DEFAULT_REGION,
  DEFAULT_RETURN_PATH,
  domain,
  type DomainStatus,
  type Region,
  resendRecord,
} from "./connector.ts";

// The `resend.domain` type's operations over Resend's domain API (`DomainApi`): the driver's calls
// it through the generated client, the fake's answers from its state. Both go through
// `domainOperations`, so they plan, adopt and refuse alike.

/** A DNS record as Resend gives one. */
export type ApiRecord = z.infer<typeof resendRecord>;

/** A domain as `GET /domains/{id}` gives it, cut to the fields read here. */
export interface ApiDomain {
  id: string;
  name: string;
  status: DomainStatus;
  region: Region;
  records: ApiRecord[];
}

/** Resend's domain API, cut. Each call fails with a `DriverError`. */
export interface DomainApi {
  /** Undefined when Resend holds a domain of that name already, in this account or another (403). */
  create(body: { name: string; region?: Region; custom_return_path?: string }): Promise<{ id: string } | undefined>;
  /** One page of `GET /domains`, after the domain `after` names; `next` the cursor of the next page, if there is one. */
  list(after?: string): Promise<{ data: { id: string; name: string }[]; next?: string }>;
  /** Undefined when Resend has no such domain (404). */
  get(id: string): Promise<ApiDomain | undefined>;
  verify(id: string): Promise<void>;
  /** Nothing when Resend has no such domain (404). */
  remove(id: string): Promise<void>;
}

/** The driver's own refusal, before or instead of a call: never retried. */
const refused = (message: string, vendorCode: string, cause?: unknown) =>
  new DriverError(`resend: ${message}`, { retryable: false, vendorCode, cause });

/** Resend's ids are UUIDs: an import id that is not one is a domain's name. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A record's full name, from the name Resend gives: Resend writes most relative to the zone
 * (`send`, or `send.mail` for `mail.example.com` in the zone `example.com`; `mail` for the
 * subdomain itself) and some in full (`links.example.com`). A relative name whose last labels
 * begin the domain's is relative to a parent zone, so those labels are not repeated.
 */
export function fullName(name: string, domainName: string): string {
  const given = name.toLowerCase().replace(/\.$/, "");
  if (given === "" || given === "@") return domainName;
  if (given === domainName || given.endsWith(`.${domainName}`)) return given;
  const labels = given.split(".");
  const parts = domainName.split(".");
  // The zone keeps two labels at least.
  for (let k = Math.min(labels.length, parts.length - 2); k > 0; k--) {
    if (labels.slice(-k).join(".") === parts.slice(0, k).join(".")) {
      return [...labels.slice(0, -k), ...parts].join(".");
    }
  }
  return `${given}.${domainName}`;
}

/** A record as a zone holds it (`dnsRecord`): its full name, a TXT record's text unquoted, `Auto` as ttl 1. */
export function dnsOf(record: ApiRecord, domainName: string): DnsRecord | undefined {
  const { data: type } = dnsRecord.shape.type.safeParse(record.type.toUpperCase());
  if (!type) return undefined;
  const seconds = Number(record.ttl);
  return {
    type,
    name: fullName(record.name, domainName),
    // A long TXT value may come as several quoted strings (`"p=AAA" "BBB"`): the zone holds them joined.
    content:
      type === "TXT" && /^".*"$/s.test(record.value) ? record.value.slice(1, -1).split(/"\s+"/).join("") : record.value,
    ...(record.priority !== undefined && { priority: record.priority }),
    ttl: Number.isInteger(seconds) && seconds > 0 ? seconds : 1,
  };
}

/**
 * A domain's state, from Resend's domain: its Return-Path from the name of its SPF MX record (or
 * of its first SPF record: Resend gives newer domains CNAME records for SPF instead).
 */
function stateOf(d: ApiDomain) {
  const name = d.name.toLowerCase();
  const dns = d.records.map((r) => ({ record: r.record, dns: dnsOf(r, name) }));
  const spf = dns.filter((r) => r.record === "SPF").map((r) => r.dns);
  const bounces = spf.find((r) => r?.type === "MX") ?? spf[0];
  const returnPath = bounces?.name.endsWith(`.${name}`) ? bounces.name.slice(0, -name.length - 1) : undefined;
  return {
    name,
    region: d.region,
    // Left out when the records do not show it: `normalize` then compares it as declared.
    ...(returnPath && { custom_return_path: returnPath }),
    id: d.id,
    status: d.status,
    records: d.records,
    dns_records: dns.flatMap((r) => (r.dns ? [r.dns] : [])),
  };
}
type State = ReturnType<typeof stateOf>;

/** What `plan` finds: the action, what it would leave, and the state it planned from. */
interface Planned {
  action: PlanAction;
  planned?: Record<string, unknown>;
  state?: State;
  /** What was declared, parsed. */
  want?: Declared;
  unknown: string[];
  replace: string[];
}

/** A declaration, parsed. */
type Declared = z.infer<typeof domain.schema>;

/** The type's operations (`domain.*`) over `api`. */
export function domainOperations(api: DomainApi) {
  /** The id of the domain named `name`, through every page of `GET /domains`. */
  const idOf = async (name: string): Promise<string | undefined> => {
    const wanted = name.toLowerCase();
    let after: string | undefined;
    for (;;) {
      const page = await api.list(after);
      const found = page.data.find((d) => d.name.toLowerCase() === wanted);
      if (found) return found.id;
      // A page with no cursor, or the same one again, is the last.
      if (!page.next || page.next === after) return undefined;
      after = page.next;
    }
  };
  const read = async ({ id }: { id: string }) => {
    const found = await api.get(id);
    return found ? { id, gone: false, state: stateOf(found) } : { id, gone: true };
  };
  /** Asks Resend to check the domain's records now, then reads it. */
  const verify = async (id: string) => {
    await api.verify(id);
    const found = await api.get(id);
    if (!found) throw refused(`domain ${id} was deleted while it was verified`, "gone");
    return { id, state: stateOf(found) };
  };
  /**
   * Creates the domain, or takes the one of that name this account holds already (a create that
   * lost its reply made it) when it is the one declared: its id.
   */
  const make = async ({ name, region, custom_return_path }: Declared): Promise<string> => {
    const made = await api.create({
      name,
      ...(region && { region }),
      ...(custom_return_path && { custom_return_path }),
    });
    if (made) return made.id;
    const id = await idOf(name);
    // Not in this account's list: another account holds it.
    if (!id) {
      throw refused(
        `domain.create: another Resend account holds ${name}; claim it in Resend's dashboard, or declare another`,
        "registered",
      );
    }
    const held = await api.get(id);
    const state = held && stateOf(held);
    const wanted = { region: region ?? DEFAULT_REGION, custom_return_path: custom_return_path ?? DEFAULT_RETURN_PATH };
    const differs = (Object.keys(wanted) as (keyof typeof wanted)[]).filter(
      (f) => state?.[f] !== undefined && state[f] !== wanted[f],
    );
    if (differs.length) {
      throw refused(
        `domain.create: this account holds ${name} (${id}) already, with another ${differs.join(" and ")}; import it, or delete it in Resend`,
        "conflict",
      );
    }
    return id;
  };
  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    const state = id === undefined ? undefined : (await read({ id })).state;
    const none = { unknown: [], replace: [] };
    if (!desired) return { action: state ? "delete" : "none", state, ...none };
    const want = domain.schema.parse(desired);
    const { immutable, vendorOwned } = domain.fields;
    const made = {
      ...want,
      region: want.region ?? DEFAULT_REGION,
      custom_return_path: want.custom_return_path ?? DEFAULT_RETURN_PATH,
      ...Object.fromEntries(vendorOwned.map((f) => [f, null])),
    };
    const unknown = [...vendorOwned];
    if (!state) return { action: "create", planned: made, want, unknown, replace: [] };
    // What drift reports: a declared field that differs, or a status other than `verified`.
    const differs = diffDeclared(domain, state, want).map((d) => d.path);
    const replace = immutable.filter((f) => differs.includes(f));
    if (replace.length) return { action: "replace", planned: made, state, want, unknown, replace };
    // Verifying again changes the statuses only: the records stay the same.
    if (differs.length) {
      return {
        action: "update",
        planned: { ...state, status: null, records: null },
        state,
        unknown: ["status", "records"],
        replace: [],
      };
    }
    return { action: "none", planned: state, state, ...none };
  };
  return {
    import: async ({ id }: { id: string }) => {
      if (UUID.test(id)) return read({ id });
      const found = await idOf(id);
      return found ? read({ id: found }) : { id, gone: true };
    },
    read,
    plan: async (input: { id?: string; desired?: Record<string, unknown> }) => {
      const { state: _, want: __, ...out } = await plan(input);
      return out;
    },
    create: async ({ desired }: { desired: Record<string, unknown> }) =>
      verify(await make(domain.schema.parse(desired))),
    // Nothing of a domain changes in place: an update asks Resend to verify it again, and a
    // replace deletes it (Resend holds one domain of a name) and makes it anew, with a new key.
    update: async ({
      id,
      desired,
      expect,
    }: {
      id: string;
      desired: Record<string, unknown>;
      expect?: { action: PlanAction; replace: string[] };
    }) => {
      const fresh = await plan({ id, desired });
      // Verified since the plan was approved (Resend found the records): what it would do is done.
      if (expect?.action === "update" && fresh.action === "none") return { id, state: fresh.state! };
      // A replace tried again after it deleted the domain: make it, taking the one that try made.
      if (expect?.action === "replace" && fresh.action === "create") return verify(await make(fresh.want!));
      if (expect && (expect.action !== fresh.action || expect.replace.join() !== fresh.replace.join())) {
        throw refused(`domain.update: the plan changed (${expect.action}, now ${fresh.action})`, "plan_changed");
      }
      if (!fresh.state) throw refused(`domain.update: there is no domain ${id}`, "gone");
      if (fresh.action === "none") return { id, state: fresh.state };
      if (fresh.action === "replace") {
        await api.remove(id);
        let made: string;
        try {
          made = await make(fresh.want!);
        } catch (error) {
          // Retried, the call finds the domain gone and makes it (above). Later: apply owns a
          // replace, deleting and unbinding, then creating as a step of its own.
          const { name, region } = fresh.state;
          const why = errorMessage(error).replace(/^resend: /, "");
          throw new DriverError(
            `resend: domain.update: deleted domain ${id} (${name}, ${region}) to make it anew, and the create failed: ${why}`,
            {
              retryable: error instanceof DriverError && error.retryable,
              vendorCode: "replace_incomplete",
              cause: error,
            },
          );
        }
        return verify(made);
      }
      return verify(id);
    },
    delete: async ({ id }: { id: string }) => {
      await api.remove(id);
      return { id, gone: true as const };
    },
  };
}
