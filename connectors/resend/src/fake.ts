import { DriverError } from "sanoma/workflows";
import { defineFake, type FakeOptions } from "sanoma/workflows/fake";
import { DEFAULT_REGION, DEFAULT_RETURN_PATH, type DomainStatus, resendOps, senderOf } from "./connector.ts";
import { type ApiDomain, type ApiRecord, type DomainApi, domainOperations } from "./domains.ts";

export interface FakeResendBroadcast {
  id: string;
  audience: string;
  from: string;
  subject: string;
  html: string;
  status: "draft" | "sent";
}

export interface FakeResendEmail {
  id: string;
  to: string | string[];
  from: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface FakeResendState extends Record<string, unknown> {
  seq: number;
  broadcasts: Record<string, FakeResendBroadcast>;
  /** The emails `emails.send` sent, by id. */
  emails: Record<string, FakeResendEmail>;
  /** The sending domains, by id, as Resend gives them. */
  domains: Record<string, ApiDomain>;
}

/** A `DriverError` as the driver makes one of Resend's answer `status`. */
const fail = (op: string, status: number, message: string, vendorCode: string) =>
  new DriverError(`resend: ${op} failed (${status}): ${message}`, { retryable: false, status, vendorCode });

/** The records Resend asks a new domain for, as it gives them: DKIM, then SPF's MX and TXT, names relative to the zone. */
function recordsFor(id: string, name: string, region: string, returnPath: string): ApiRecord[] {
  const pending = { ttl: "Auto", status: "not_started" };
  // Named relative to the zone, as Resend names them: the fake takes the zone to be the last two labels.
  const sub = name.split(".").slice(0, -2).join(".");
  const at = (label: string) => (sub ? `${label}.${sub}` : label);
  // Made up from the id: the same in every run, and a domain made again gets a new one, as at Resend.
  const key = Buffer.from(`fake DKIM key ${id}`).toString("base64");
  return [
    { record: "DKIM", name: at("resend._domainkey"), type: "TXT", value: `p=${key}`, ...pending },
    {
      record: "SPF",
      name: at(returnPath),
      type: "MX",
      value: `feedback-smtp.${region}.amazonses.com`,
      priority: 10,
      ...pending,
    },
    { record: "SPF", name: at(returnPath), type: "TXT", value: "v=spf1 include:amazonses.com ~all", ...pending },
  ];
}

/** Resend's domain API as the fake answers it, from `state`. */
function fakeDomains(state: FakeResendState): DomainApi {
  return {
    async create({ name, region = DEFAULT_REGION, custom_return_path = DEFAULT_RETURN_PATH }) {
      if (Object.values(state.domains).some((d) => d.name === name)) return undefined;
      const id = `00000000-0000-4000-8000-${String(++state.seq).padStart(12, "0")}`;
      state.domains[id] = {
        id,
        name,
        region,
        status: "not_started",
        records: recordsFor(id, name, region, custom_return_path),
      };
      return { id };
    },
    list: async () => ({ data: Object.values(state.domains).map(({ id, name }) => ({ id, name })) }),
    get: async (id) => {
      const found = state.domains[id];
      return found && structuredClone(found);
    },
    async verify(id) {
      const found = state.domains[id];
      if (!found) throw fail("domain.verify", 404, "Domain not found", "not_found");
      // The fake has no DNS to look in: it checks for as long as Resend would, until `verifyDomain` or `failDomain`.
      if (found.status !== "verified") setStatus(found, "pending");
    },
    async remove(id) {
      delete state.domains[id];
    },
  };
}

/** Gives a domain and each of its records `status`. */
function setStatus(found: ApiDomain, status: DomainStatus) {
  found.status = status;
  for (const record of found.records) record.status = status;
}

/**
 * An in-memory Resend for tests: broadcasts in `state.broadcasts`, the emails sent in
 * `state.emails`, sending domains in `state.domains` (README, "Testing"); nothing is emailed.
 */
export function fakeResend(options: FakeOptions = {}) {
  const fake = defineFake(
    resendOps,
    {
      initial: (): FakeResendState => ({ seq: 0, broadcasts: {}, emails: {}, domains: {} }),
      ops: (state) => ({
        domain: domainOperations(fakeDomains(state)),
        broadcast: {
          create: async (input) => {
            const from = senderOf("broadcast.create", input.from);
            const id = `bc_${String(++state.seq).padStart(4, "0")}`;
            state.broadcasts[id] = { id, ...input, from, status: "draft" };
            return { id };
          },
          send: async ({ id }) => {
            const bc = state.broadcasts[id];
            if (!bc) throw new DriverError(`resend: no broadcast ${id}`, { retryable: false, status: 404 });
            if (bc.status === "sent") {
              throw new DriverError(`resend: broadcast ${id} was already sent`, { retryable: false, status: 422 });
            }
            bc.status = "sent";
            return { id, status: "queued" as const };
          },
        },
        emails: {
          send: async (input) => {
            const from = senderOf("emails.send", input.from);
            const id = `em_${String(++state.seq).padStart(4, "0")}`;
            state.emails[id] = { id, ...input, from };
            return { id };
          },
        },
      }),
    },
    options,
  );
  const domainOf = (id: string) => {
    const found = fake.state.domains[id];
    if (!found) throw new Error(`fake resend: no domain ${id}`);
    return found;
  };
  return Object.assign(fake, {
    /** Resend found the domain's records: it and each record are `verified`. */
    verifyDomain: (id: string) => setStatus(domainOf(id), "verified"),
    /** Resend gave up on the domain's records: it and each record are `failed`. */
    failDomain: (id: string) => setStatus(domainOf(id), "failed"),
  });
}
