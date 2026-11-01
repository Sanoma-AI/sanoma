import { z } from "zod";

/** All numeric input is decimal text. No float coercion and no empty-to-zero fallback. */
export const decimalSchema = z
  .string()
  .regex(/^\d{1,9}(?:\.\d{1,4})?$/, "Enter a non-negative decimal with at most four decimal places");
export const quantitySchema = z
  .string()
  .regex(/^\d{1,6}(?:\.\d{1,4})?$/, "Enter a quantity with at most four decimal places")
  .refine((value) => /[1-9]/.test(value), "Quantity must be greater than zero");
export const currencyPrecision = { USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, JPY: 0, KWD: 3 } as const;
export const currencySchema = z.enum(["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "KWD"]);
export type Currency = z.infer<typeof currencySchema>;

const text = (max: number) => z.string().trim().min(1).max(max);
export const dateSchema = z.iso.date();
export const addressSchema = z.strictObject({
  lines: z.array(text(160)).min(1).max(3),
  city: text(100).optional(),
  region: text(100).optional(),
  postalCode: text(32).optional(),
  country: text(100).optional(),
});
export const partySchema = z.strictObject({
  name: text(160),
  email: z.email().max(254).optional(),
  phone: text(50).optional(),
  address: addressSchema.optional(),
});
export const lineSchema = z.strictObject({
  description: text(1000),
  quantity: quantitySchema,
  unit: z.enum(["visit", "hour", "night", "job", "item", "charge"]),
  unitPrice: decimalSchema,
  serviceDate: dateSchema.optional(),
});
const periodSchema = z
  .strictObject({ start: dateSchema, end: dateSchema })
  .refine((period) => period.end >= period.start, { message: "End date must not precede start date", path: ["end"] });

/** Package-owned styles; callers supply data, not executable templates or remote asset URLs. */
export const presentationSchema = z
  .strictObject({
    template: z.literal("standard").default("standard"),
    paper: z.enum(["A4", "LETTER"]).default("A4"),
    accent: z
      .string()
      .regex(/^#[\da-fA-F]{6}$/, "Use a six-digit hex color")
      .default("#245648"),
  })
  .default({ template: "standard", paper: "A4", accent: "#245648" });

/** Shared by industry inputs; values are explicit, with no clock or customer-store lookup. */
export const invoiceFields = {
  schemaVersion: z.literal(1).default(1),
  number: text(80),
  issuedOn: dateSchema,
  dueOn: dateSchema.optional(),
  servicePeriod: periodSchema.optional(),
  issuer: partySchema,
  recipient: partySchema,
  serviceAddress: addressSchema.optional(),
  currency: currencySchema,
  locale: z.enum(["en-US", "en-GB", "de-DE", "fr-FR"]).default("en-US"),
  discount: decimalSchema.default("0"),
  taxPercent: decimalSchema.refine((value) => Number(value) <= 100, "Tax percentage must be at most 100").default("0"),
  paid: decimalSchema.default("0"),
  notes: z.string().trim().max(4000).optional(),
  presentation: presentationSchema,
};

export const invoiceSchema = z
  .strictObject({
    ...invoiceFields,
    lines: z.array(lineSchema).min(1).max(200),
    details: z
      .array(z.strictObject({ label: text(80), value: text(4000) }))
      .max(20)
      .optional(),
  })
  .superRefine((invoice, ctx) => {
    if (invoice.dueOn && invoice.dueOn < invoice.issuedOn)
      ctx.addIssue({ code: "custom", path: ["dueOn"], message: "Due date must not precede issue date" });
    const precision = currencyPrecision[invoice.currency];
    for (const field of ["discount", "paid"] as const) {
      const fraction = invoice[field].split(".")[1] ?? "";
      if (/[1-9]/.test(fraction.slice(precision)))
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${invoice.currency} amounts support ${precision} decimal places`,
        });
    }
  });

export type InvoiceInput = z.input<typeof invoiceSchema>;
export type Invoice = z.output<typeof invoiceSchema>;
export type InvoiceLine = z.output<typeof lineSchema>;
