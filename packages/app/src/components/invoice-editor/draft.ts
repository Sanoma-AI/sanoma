import {
  cleaningInvoice,
  cleaningSchema,
  InvoiceValidationError,
  petSittingInvoice,
  petSittingSchema,
  type CleaningInput,
  type InvoiceIssue,
  type PetSittingInput,
} from "@sanoma-ai/invoices";
import type { PdfOptions } from "@sanoma-ai/invoices/pdf-contract";

export type Industry = "pet-sitting" | "cleaning";
export interface AddressDraft {
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}
export interface PartyDraft extends AddressDraft {
  name: string;
  email: string;
  phone: string;
}
export interface ServiceDraft {
  id: number;
  service: string;
  description: string;
  quantity: string;
  unitPrice: string;
  unit: string;
  serviceDate: string;
}
export interface InvoiceDraft {
  number: string;
  issuedOn: string;
  dueOn: string;
  periodStart: string;
  periodEnd: string;
  issuer: PartyDraft;
  recipient: PartyDraft;
  serviceAddress: AddressDraft;
  currency: string;
  locale: string;
  discount: string;
  taxPercent: string;
  paid: string;
  pets: string;
  property: string;
  services: ServiceDraft[];
  notes: string;
  paper: string;
  accent: string;
  logo?: PdfOptions["logo"];
  logoError: string;
}

const addressDraft = (source?: PetSittingInput["serviceAddress"]): AddressDraft => ({
  street: source?.lines.join("\n") ?? "",
  city: source?.city ?? "",
  region: source?.region ?? "",
  postalCode: source?.postalCode ?? "",
  country: source?.country ?? "",
});
const partyDraft = (party?: PetSittingInput["issuer"]): PartyDraft => ({
  ...addressDraft(party?.address),
  name: party?.name ?? "",
  email: party?.email ?? "",
  phone: party?.phone ?? "",
});
export const newService = (kind: Industry, id: number): ServiceDraft => ({
  id,
  service: kind === "pet-sitting" ? "visit" : "standard",
  description: "",
  quantity: "1",
  unitPrice: "",
  unit: "job",
  serviceDate: "",
});

/** Initial props are read once per mounted editor. No storage or ambient date/default lookup. */
export function initialDraft(kind: Industry, input?: PetSittingInput | CleaningInput): InvoiceDraft {
  return {
    number: input?.number ?? "",
    issuedOn: input?.issuedOn ?? "",
    dueOn: input?.dueOn ?? "",
    periodStart: input?.servicePeriod?.start ?? "",
    periodEnd: input?.servicePeriod?.end ?? "",
    issuer: partyDraft(input?.issuer),
    recipient: partyDraft(input?.recipient),
    serviceAddress: addressDraft(input?.serviceAddress),
    currency: input?.currency ?? "USD",
    locale: input?.locale ?? "en-US",
    discount: input?.discount ?? "0",
    taxPercent: input?.taxPercent ?? "0",
    paid: input?.paid ?? "0",
    notes: input?.notes ?? "",
    pets: input && "pets" in input ? input.pets.join("\n") : "",
    property: input && "property" in input ? (input.property ?? "") : "",
    services: input?.services.map((line, i) => ({
      ...newService(kind, i + 1),
      ...line,
      description: line.description ?? "",
      serviceDate: line.serviceDate ?? "",
    })) ?? [newService(kind, 1)],
    paper: input?.presentation?.paper ?? "A4",
    accent: input?.presentation?.accent ?? "#245648",
    logoError: "",
  };
}

const optional = (text: string) => text.trim() || undefined;
function address(value: AddressDraft) {
  if (![value.street, value.city, value.region, value.postalCode, value.country].some((part) => part.trim()))
    return undefined;
  return {
    lines: value.street
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    city: optional(value.city),
    region: optional(value.region),
    postalCode: optional(value.postalCode),
    country: optional(value.country),
  };
}
const party = (value: PartyDraft) => ({
  name: value.name,
  email: optional(value.email),
  phone: optional(value.phone),
  address: address(value),
});

/** Field-to-domain conversion only. All schemas, industry defaults and money rules stay portable. */
export function draftRequest(kind: Industry, value: InvoiceDraft) {
  if (value.logoError)
    throw new InvoiceValidationError([{ code: "invalid_logo", path: ["logo"], message: value.logoError }]);
  const common = {
    number: value.number,
    issuedOn: value.issuedOn,
    dueOn: optional(value.dueOn),
    servicePeriod:
      value.periodStart || value.periodEnd ? { start: value.periodStart, end: value.periodEnd } : undefined,
    issuer: party(value.issuer),
    recipient: party(value.recipient),
    serviceAddress: address(value.serviceAddress),
    currency: value.currency,
    locale: value.locale,
    discount: value.discount,
    taxPercent: value.taxPercent,
    paid: value.paid,
    notes: optional(value.notes),
    presentation: { paper: value.paper, accent: value.accent },
    services: value.services.map(({ service, description, quantity, unitPrice, serviceDate, unit }) => ({
      service,
      description: optional(description),
      quantity,
      unitPrice,
      serviceDate: optional(serviceDate),
      ...(kind === "cleaning" ? { unit } : {}),
    })),
  };
  const result =
    kind === "pet-sitting"
      ? petSittingSchema.safeParse({
          ...common,
          pets: value.pets
            .split("\n")
            .map((pet) => pet.trim())
            .filter(Boolean),
        })
      : cleaningSchema.safeParse({ ...common, property: optional(value.property) });
  if (!result.success)
    throw new InvoiceValidationError(
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    );
  const invoice = "pets" in result.data ? petSittingInvoice(result.data) : cleaningInvoice(result.data);
  return { invoice, options: value.logo ? { logo: value.logo } : {} };
}

/** Portable issue paths translated to the editor's labelled controls. */
export function fieldPath(issue: InvoiceIssue): string {
  const path = [...issue.path];
  if (path[0] === "lines") path[0] = "services";
  if (path[0] === "pets") return "pets";
  if (path[0] === "servicePeriod") return path[1] === "end" ? "periodEnd" : "periodStart";
  if (path[0] === "presentation") return String(path[1]);
  if (path[0] === "options" || path[0] === "logo") return "logo";
  if (path[0] === "issuer" || path[0] === "recipient") {
    if (path[1] === "address") path.splice(1, 1);
  }
  const at = path.indexOf("lines");
  if (at >= 0) path.splice(at, path.length - at, "street");
  return path.reduce<string>(
    (name, part) => (typeof part === "number" ? `${name}[${part}]` : name ? `${name}.${part}` : part),
    "",
  );
}

export function draftErrors(kind: Industry, value: InvoiceDraft) {
  try {
    draftRequest(kind, value);
    return undefined;
  } catch (error) {
    if (!(error instanceof InvoiceValidationError)) throw error;
    return { fields: Object.fromEntries(error.issues.map((issue) => [fieldPath(issue), issue.message])) };
  }
}
