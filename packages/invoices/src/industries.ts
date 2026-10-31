import { z } from "zod";
import { calculateInvoice, InvoiceValidationError } from "./calculate.ts";
import { invoiceFields, lineSchema, type InvoiceLine } from "./schema.ts";

export const petServices = {
  visit: { label: "Pet visit", unit: "visit" },
  walk: { label: "Dog walk", unit: "visit" },
  overnight: { label: "Overnight stay", unit: "night" },
  "additional-pet": { label: "Additional pet", unit: "charge" },
  holiday: { label: "Holiday surcharge", unit: "charge" },
  other: { label: "Other service", unit: "charge" },
} as const;
export const cleaningServices = {
  standard: "Standard cleaning",
  deep: "Deep cleaning",
  "move-out": "Move-out cleaning",
  oven: "Oven cleaning",
  refrigerator: "Refrigerator cleaning",
  windows: "Interior windows",
  other: "Other cleaning service",
} as const;
const serviceFields = {
  description: lineSchema.shape.description.optional(),
  quantity: lineSchema.shape.quantity,
  unitPrice: lineSchema.shape.unitPrice,
  serviceDate: lineSchema.shape.serviceDate,
};
export const petSittingSchema = z.strictObject({
  ...invoiceFields,
  pets: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  services: z
    .array(
      z.strictObject({
        ...serviceFields,
        service: z.enum(["visit", "walk", "overnight", "additional-pet", "holiday", "other"]),
      }),
    )
    .min(1)
    .max(200),
});
export const cleaningSchema = z.strictObject({
  ...invoiceFields,
  property: z.string().trim().min(1).max(160).optional(),
  services: z
    .array(
      z.strictObject({
        ...serviceFields,
        service: z.enum(["standard", "deep", "move-out", "oven", "refrigerator", "windows", "other"]),
        unit: z.enum(["job", "hour", "visit"]).default("job"),
      }),
    )
    .min(1)
    .max(200),
});
export type PetSittingInput = z.input<typeof petSittingSchema>;
export type CleaningInput = z.input<typeof cleaningSchema>;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new InvoiceValidationError(
      result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    );
  return result.data;
}

/** Returns canonical validated input; all pricing still belongs to calculateInvoice. */
export function petSittingInvoice(input: PetSittingInput) {
  const { pets, services, ...base } = parse(petSittingSchema, input);
  const lines: InvoiceLine[] = services.map(({ service, description, ...line }) => ({
    ...line,
    description: description ?? petServices[service].label,
    unit: petServices[service].unit,
  }));
  return normalize({ ...base, lines, details: [{ label: "Pets", value: pets.join(", ") }] });
}
export function cleaningInvoice(input: CleaningInput) {
  const { property, services, ...base } = parse(cleaningSchema, input);
  const lines: InvoiceLine[] = services.map(({ service, description, ...line }) => ({
    ...line,
    description: description ?? cleaningServices[service],
  }));
  return normalize({ ...base, lines, details: property ? [{ label: "Property", value: property }] : [] });
}

// Keep calculation errors addressable by the industry form's field names.
function normalize(input: unknown) {
  try {
    return calculateInvoice(input).invoice;
  } catch (error) {
    if (!(error instanceof InvoiceValidationError)) throw error;
    throw new InvoiceValidationError(
      error.issues.map((issue) => ({
        ...issue,
        path: issue.path[0] === "lines" ? ["services", ...issue.path.slice(1)] : issue.path,
      })),
    );
  }
}
