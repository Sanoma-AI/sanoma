import { type DnsRecord, DriverError, errorMessage, type PlanAction } from "@sanoma-ai/workflows";
import { z } from "zod";
import { caaData, canonicalRecord, keyOf, records as recordsType } from "./connector.ts";
import {
  type CloudflareApi,
  type DnsBatch,
  inZone,
  NONE,
  type Planned,
  type RecordWrite,
  refused,
  replanned,
  type ZoneRecord,
} from "./ops.ts";

// `cloudflare.records`' operations over `CloudflareApi`: the driver's calls Cloudflare's DNS API
// with the SDK, the fake's answers from its zones. Both go through `recordsOps`, so they find,
// plan, adopt and refuse alike.

/** The permission a token needs for a set, as the dashboard names it. */
const DNS_EDIT = "Zone → DNS → Edit";
/** The longest comment a record of a Free zone holds, which the mark is. */
const MARK_MAX = 100;

/** A set's state: its zone and label, its records by key, and their ids beside. */
type RecordsState = {
  zone: string;
  name: string;
  records: DnsRecord[];
  zone_id: string;
  record_ids: string[];
};

/** A record the zone holds: its id, comment and whether it is proxied, and the record in the shared shape (`canonicalRecord`), with its key. */
interface Held {
  id: string;
  comment: string | undefined;
  proxied: boolean;
  record: DnsRecord;
  key: string;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const heldOf = ({ id, comment, proxied, ...rest }: ZoneRecord): Held => {
  const record = canonicalRecord(rest);
  return { id, comment: comment ?? undefined, proxied: proxied === true, record, key: keyOf(record) };
};

/** `<zone>/<name>`, a set's id, split. */
function idOf(id: string) {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) throw refused(`records: ${id} is not <zone>/<name>`);
  return { zone: id.slice(0, at), name: id.slice(at + 1) };
}

/**
 * The mark of the set `<zone>/<name>`, `sanoma:<zone>/<name>`: the comment of every record it
 * writes; a refusal when it is longer than a record's comment holds on a Free zone.
 */
function markOf(zone: string, name: string) {
  const mark = `sanoma:${zone}/${name}`;
  if (mark.length > MARK_MAX) {
    throw refused(
      `records ${zone}/${name}: its mark ${mark} is ${mark.length} characters, and a record's comment holds ${MARK_MAX}: give the set a shorter name`,
      "invalid",
    );
  }
  return mark;
}

/**
 * A set's declared records, each in its compared form, each once; a refusal for none, one the
 * shared shape refuses, one whose name is not in the zone, an MX record without a priority, a
 * CAA record's content not its fields, two of one type, name and content that differ otherwise
 * (Cloudflare holds one of them), or a CNAME beside another record of its name.
 */
function declaredRecords(zone: string, name: string, given: unknown): DnsRecord[] {
  const set = `${zone}/${name}`;
  const parsed = recordsType.schema.shape.records.safeParse(given);
  if (!parsed.success) throw refused(`records ${set}: ${z.prettifyError(parsed.error)}`, "invalid");
  const seen = new Map<string, DnsRecord>();
  for (const record of parsed.data.map((r) => canonicalRecord(r))) {
    if (!inZone(record.name, zone)) {
      throw refused(`records ${set}: ${record.type} ${record.name} is not in the zone ${zone}`, "invalid");
    }
    if (record.type === "MX" && record.priority === undefined) {
      throw refused(`records ${set}: the MX record ${record.name} needs a priority`, "invalid");
    }
    if (record.type === "CAA" && !caaData(record.content)) {
      throw refused(
        `records ${set}: a CAA record's content is \`<flags> <tag> "<value>"\`, not ${record.content}`,
        "invalid",
      );
    }
    const same = JSON.stringify([record.type, record.name, record.content]);
    const before = seen.get(same);
    if (before && keyOf(before) !== keyOf(record)) {
      throw refused(
        `records ${set}: ${record.type} ${record.name} ${JSON.stringify(record.content)} is declared twice, with another ttl or priority`,
        "invalid",
      );
    }
    seen.set(same, record);
  }
  const declared = [...seen.values()];
  const cname = declared.find((r) => r.type === "CNAME" && declared.some((o) => o !== r && o.name === r.name));
  if (cname) {
    throw refused(
      `records ${set}: the CNAME ${cname.name} is declared beside another record of its name, which a CNAME cannot stand beside`,
      "invalid",
    );
  }
  const second = declared.find(
    (r) => spfRecord(r) && declared.some((o) => o !== r && o.name === r.name && spfRecord(o)),
  );
  if (second) {
    throw refused(
      `records ${set}: two SPF policies are declared at ${second.name}, which makes both invalid: merge them into one`,
      "invalid",
    );
  }
  return declared;
}

/**
 * How the zone's marked records become the declared ones: those kept as they are, those patched
 * (a marked record of the same type and name, with other content, priority or ttl, or proxied by
 * hand), the declared ones no marked record holds, which a write posts or adopts, and the marked
 * ones no longer declared.
 */
function diff(declared: DnsRecord[], held: Held[]) {
  const left = [...held];
  const take = (match: (h: Held) => boolean) => {
    const at = left.findIndex(match);
    return at < 0 ? undefined : left.splice(at, 1)[0];
  };
  /** The records no marked one `matches`, the others paired with the one each takes, into `into`. */
  const pair = (records: DnsRecord[], matches: (h: Held, record: DnsRecord) => boolean, into: [Held, DnsRecord][]) =>
    records.filter((record) => {
      const slot = take((h) => matches(h, record));
      if (slot) into.push([slot, record]);
      return !slot;
    });
  const kept: [Held, DnsRecord][] = [];
  const patched: [Held, DnsRecord][] = [];
  const at = (h: Held, record: DnsRecord) => h.record.type === record.type && h.record.name === record.name;
  // Each declared record held exactly first, so a patch never takes a record another one keeps;
  // then one of the same content (its ttl or priority changed), then any of its type and name.
  const unheld = pair(declared, (h, record) => h.key === keyOf(record) && !h.proxied, kept);
  const missing = pair(
    pair(unheld, (h, record) => at(h, record) && h.record.content === record.content, patched),
    at,
    patched,
  );
  return { kept: kept.map(([h]) => h), patched, missing, stale: left };
}

/** A declared record as a batch writes it, with the set's mark. */
const writeOf = (mark: string, record: DnsRecord): RecordWrite => ({
  type: record.type,
  name: record.name,
  ttl: record.ttl ?? 1,
  proxied: false,
  comment: mark,
  ...(record.type === "CAA" ? { data: caaData(record.content)! } : { content: record.content }),
  ...(record.priority !== undefined && { priority: record.priority }),
});

/** A record as a refusal names it. */
const named = ({ record, comment }: Held) =>
  `${record.type} ${record.name} ${JSON.stringify(record.content)}${comment ? ` (its comment: ${comment})` : ""}`;

/**
 * Whether an unmarked record at a declared record's name keeps it from being written: a CNAME,
 * which no other record may stand beside (and a declared CNAME beside any record), a second SPF
 * policy, which makes both invalid, or an MX record to the same server at another priority.
 */
const clashes = (record: DnsRecord, { record: other }: Held) =>
  other.type === "CNAME" ||
  record.type === "CNAME" ||
  (spfRecord(record) && spfRecord(other)) ||
  (record.type === "MX" && other.type === "MX" && record.content === other.content);

/** Whether a TXT record's text is an SPF policy: `v=spf1`, in any case. */
const isSpf = (text: string) => /^v=spf1(\s|$)/i.test(text);
/** Whether a record is an SPF policy: a TXT record whose text is one. */
const spfRecord = (record: DnsRecord) => record.type === "TXT" && isSpf(record.content);

/** `call`'s answer, a 403 refused as the token's missing permission on the zone. */
async function dns<T>(zone: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof DriverError && error.status === 403)) throw error;
    throw new DriverError(
      `cloudflare: the API token may not edit the DNS records of ${zone} (${errorMessage(error)}): give it ${DNS_EDIT} on the zone ${zone}`,
      { retryable: false, status: 403, vendorCode: "no_dns_permission", cause: error },
    );
  }
}

/** The refusal of records given as `null` at a write: a backstop, since apply fails such a step before it gets here. */
const notKnown = (set: string) =>
  refused(`records ${set}: its records are not known yet: apply the resource they come from first`, "not_known");

/** The refusal of a set whose zone is not listed: the account holds no such zone, or the token cannot read it. */
const noZone = (set: string, zone: string) =>
  refused(
    `records ${set}: the account holds no zone ${zone}, or the API token cannot read it: add the zone to the account, or Zone Read and ${DNS_EDIT} on it to the token`,
    "no_zone",
  );

/** What `look` finds of a set. */
type Found = Awaited<ReturnType<typeof look>>;

/**
 * The set `id`: its mark (`sanoma:<zone>/<name>`, the comment of every record it writes), its
 * zone's id (undefined when the account holds no such zone) and the records that carry its mark.
 */
async function look(cf: CloudflareApi, id: string) {
  const { zone, name } = idOf(id);
  const mark = markOf(zone, name);
  const zoneId = await cf.zone(zone);
  // Cloudflare's `comment.exact` ignores case: a comment that is the mark in another case is not the set's.
  const held =
    zoneId === undefined
      ? []
      : (await dns(zone, () => cf.dnsRecords(zoneId, mark))).map(heldOf).filter((h) => h.comment === mark);
  return { zone, name, mark, zoneId, held };
}

/** A set's state, from the records that carry its mark. */
function stateOf(zone: string, name: string, zoneId: string, held: Held[]): RecordsState {
  const sorted = held.toSorted((a, b) => compare(a.key, b.key));
  return { zone, name, records: sorted.map((h) => h.record), zone_id: zoneId, record_ids: sorted.map((h) => h.id) };
}

/** What `desired` changes of the set `found` found (none found: a create). */
function planOf(found: Found | undefined, desired: Record<string, unknown>): Planned {
  const zone = String(desired.zone);
  const name = String(desired.name);
  markOf(zone, name);
  // `null`: taken from another resource's state, known only after apply.
  const given = desired.records;
  const records =
    given === null || given === undefined
      ? given
      : declaredRecords(zone, name, given).toSorted((a, b) => compare(keyOf(a), keyOf(b)));
  /** A new set's unknown fields: Cloudflare's, and its records while they are not known. */
  const unknown = [...(records == null ? ["records"] : []), ...recordsType.fields.vendorOwned];
  const anew = { zone, name, records: records ?? null };
  if (!found?.zoneId || found.held.length === 0) return { action: "create", planned: anew, unknown, replace: [] };
  const state = stateOf(found.zone, found.name, found.zoneId, found.held);
  const replace = recordsType.fields.immutable.filter(
    (field) => desired[field] !== (state as Record<string, unknown>)[field],
  );
  if (replace.length > 0) return { action: "replace", planned: anew, unknown, replace };
  // Left out: its resource is absent or unreadable, so the set keeps what it holds.
  if (records === undefined) return { action: "none", planned: state, ...NONE };
  if (records === null) {
    return {
      action: "update",
      planned: { ...state, records: null, record_ids: null },
      unknown: ["records", "record_ids"],
      replace: [],
    };
  }
  const { patched, missing, stale } = diff(records, found.held);
  if (patched.length + missing.length + stale.length === 0) return { action: "none", planned: state, ...NONE };
  return { action: "update", planned: { ...state, records, record_ids: null }, unknown: ["record_ids"], replace: [] };
}

/**
 * `cloudflare.records`' operations over `api()`, made on each call. A read finds a set's records
 * by its mark alone; a write is one batch, all or nothing, of posts, patches (a marked record of a
 * declared one's type and name, or an unmarked one identical to it, adopted: its comment replaced
 * by the mark) and deletes (marked, no longer declared), and never touches another record: one in
 * its way (a CNAME at the name, another SPF policy, an MX to the same server at another priority,
 * a proxied one identical to it) is refused, naming it.
 */
export function recordsOps(api: () => CloudflareApi) {
  /** The set `id` as the zone holds it, or gone: no record carries its mark, or the zone is not the account's. */
  const read = async ({ id }: { id: string }) => {
    const { zone, name, zoneId, held } = await look(api(), id);
    if (zoneId === undefined || held.length === 0) return { id, gone: true };
    return { id, gone: false, state: stateOf(zone, name, zoneId, held) };
  };

  const plan = async ({ id, desired }: { id?: string; desired?: Record<string, unknown> }): Promise<Planned> => {
    // A create plans without the account: it needs no credentials yet.
    const found = id === undefined ? undefined : await look(api(), id);
    if (!desired) return { action: found?.held.length ? "delete" : "none", ...NONE };
    return planOf(found, desired);
  };

  /**
   * Makes the zone hold the declared records, in one batch: a create and an update alike, the
   * latter with the account and what its plan found.
   */
  const put = async (desired: Record<string, unknown>, before?: { cf: CloudflareApi; found: Found }) => {
    const set = `${String(desired.zone)}/${String(desired.name)}`;
    if (desired.records === null || desired.records === undefined) throw notKnown(set);
    const declared = declaredRecords(String(desired.zone), String(desired.name), desired.records);
    const cf = before?.cf ?? api();
    const { zone, name, mark, zoneId, held } = before?.found ?? (await look(cf, set));
    if (zoneId === undefined) {
      throw noZone(set, zone);
    }
    const { kept, patched, missing, stale } = diff(declared, held);
    const batch: DnsBatch = { posts: [], patches: [], deletes: stale.map(({ id }) => ({ id })) };
    // The other records at each name a record is written to, looked up once per name, before
    // anything is written: one identical to it is adopted, one in its way refused.
    const others = new Map<string, Held[]>();
    const othersAt = async (at: string) => {
      let found = others.get(at);
      if (!found) {
        found = (await dns(zone, () => cf.dnsRecordsAt(zoneId, at))).map(heldOf).filter((h) => h.comment !== mark);
        others.set(at, found);
      }
      return found;
    };
    /** The other record at its name (`at`) identical to `record` (its type, content and priority), taken to adopt; a refusal for another set's or a proxied one. */
    const adoptable = (record: DnsRecord, at: Held[]) => {
      const same = at.findIndex(
        (o) =>
          o.record.type === record.type && o.record.content === record.content && o.record.priority === record.priority,
      );
      if (same < 0) return undefined;
      const [adopted] = at.splice(same, 1) as [Held];
      if (adopted.comment?.startsWith("sanoma:")) {
        throw refused(`records ${set}: ${record.type} ${record.name} is another set's: ${named(adopted)}`, "conflict");
      }
      if (adopted.proxied) {
        throw refused(
          `records ${set}: ${named(adopted)} is proxied through Cloudflare, and a set's records are not: turn its proxy off by hand to have it adopted, or delete it`,
          "conflict",
        );
      }
      return adopted;
    };
    // Each record to patch (its marked `slot`) or to post, in that order.
    const writes: [Held | undefined, DnsRecord][] = [
      ...patched,
      ...missing.map((r): [undefined, DnsRecord] => [undefined, r]),
    ];
    for (const [slot, record] of writes) {
      // What another record already is: that one adopted instead (its comment replaced by the mark), its own deleted.
      const at = await othersAt(record.name);
      const adopted = adoptable(record, at);
      if (adopted) {
        if (slot) batch.deletes.push({ id: slot.id });
        batch.patches.push({ id: adopted.id, ...writeOf(mark, record) });
        continue;
      }
      const clash = at.find((other) => clashes(record, other));
      if (clash) {
        throw refused(
          `records ${set}: ${record.type} ${record.name} cannot be written beside ${named(clash)}, which is not this set's: delete or change it by hand, or declare it as it is, which adopts it`,
          "conflict",
        );
      }
      if (slot) batch.patches.push({ id: slot.id, ...writeOf(mark, record) });
      else batch.posts.push(writeOf(mark, record));
    }
    const written =
      batch.posts.length + batch.patches.length + batch.deletes.length === 0
        ? { patches: [], posts: [] }
        : await dns(zone, () => cf.writeDns(zoneId, batch));
    const now = [...kept, ...[...written.patches, ...written.posts].map(heldOf)];
    return { id: set, state: stateOf(zone, name, zoneId, now) };
  };

  return {
    import: read,
    read,
    plan,
    create: ({ desired }: { desired: Record<string, unknown> }) => put(desired),
    update: async ({
      id,
      desired,
      expect,
    }: {
      id: string;
      desired: Record<string, unknown>;
      expect?: { action: PlanAction; replace: string[] };
    }) => {
      // Before any request, as at a create.
      if (desired.records === null) throw notKnown(id);
      const cf = api();
      const found = await look(cf, id);
      const fresh = planOf(found, desired);
      // An update planned and found done (a retry after its batch was written) is done: the zone holds what was declared.
      if (!(expect?.action === "update" && fresh.action === "none")) replanned("records.update", fresh, expect);
      // Records left out, or as declared: what the zone holds, unwritten.
      if (fresh.action === "none") return { id, state: fresh.planned as RecordsState };
      return put(desired, { cf, found });
    },
    delete: async ({ id }: { id: string }) => {
      const cf = api();
      const { zone, zoneId, held } = await look(cf, id);
      // A zone the token cannot read is not listed, as one the account does not hold: Cloudflare
      // answers both alike, so a delete is refused rather than done with the records left behind.
      if (zoneId === undefined) throw noZone(id, zone);
      if (held.length > 0) {
        await dns(zone, () =>
          cf.writeDns(zoneId, { posts: [], patches: [], deletes: held.map((h) => ({ id: h.id })) }),
        );
      }
      return { id, gone: true as const };
    },
  };
}
