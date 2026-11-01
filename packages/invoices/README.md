# @sanoma-ai/invoices

Portable invoice validation and calculation for browser tools and headless workflows. Pet-sitting and cleaning adapters turn industry-specific inputs into one invoice model. There are no browser, React, database, network, clock or storage dependencies.

```sh
pnpm add @sanoma-ai/invoices
```

```ts
import { calculateInvoice, petSittingInvoice, formatMoney } from "@sanoma-ai/invoices";
import { petSittingExample } from "@sanoma-ai/invoices/examples";

const invoice = petSittingInvoice(petSittingExample);
const result = calculateInvoice(invoice);
formatMoney(result.totals.dueMinor, invoice.currency, invoice.locale); // $180.00
```

## Contract

`InvoiceInput` contains an explicit invoice number, issue date, issuer, recipient, currency and line items. Each line supplies a description, unit, quantity and unit price. Optional fields include a due date, service period, service address, notes, a flat discount, tax percentage and payment already received. Billing and service addresses are independent. Optional `details` are bounded plain-text label/value pairs; the core schema contains no industry-specific fields. `invoiceSchema` describes the canonical runtime contract; `Invoice` is its validated output with defaults applied. `schemaVersion` is currently `1`.

Quantities and monetary values are **decimal strings**, never JavaScript numbers. Inputs are not coerced: an empty price is invalid, not zero. Quantities must be positive with up to six integer and four fractional digits. Prices, discounts and payments allow up to nine integer and four fractional digits. Discounts and payments must be representable in the currency's minor unit (trailing zeroes are accepted). Prices may have extra precision because each line is rounded after multiplying by quantity.

Supported currencies are USD, EUR, GBP, AUD and CAD (two decimal places), JPY (zero) and KWD (three). Supported formatting locales are `en-US`, `en-GB`, `de-DE` and `fr-FR`. Text remains caller-supplied; locale does not translate descriptions. Calendar dates use `YYYY-MM-DD`, with no timezone conversion. Due dates and service periods cannot run backwards.

`calculateInvoice(input)` validates unknown input and returns the normalized invoice, calculated lines and totals as safe integer minor units. BigInt arithmetic applies these rules:

1. Multiply each decimal quantity by its decimal unit price and round half up to the currency's minor unit.
2. Sum the rounded line amounts, then subtract the flat discount.
3. Calculate tax on that discounted subtotal and round half up once.
4. Add tax, then subtract the amount paid to get the balance due.

Negative values, discounts exceeding the subtotal, payments exceeding the total, tax over 100%, and amounts exceeding JavaScript's safe integer range are rejected. This version does not model credits, multiple tax rates, inclusive tax or jurisdiction-specific tax rules. It does not allocate invoice numbers or send, store or collect invoices.

`formatMoney(minor, currency, locale?)` formats safe integer minor units without converting the major amount to floating point.

## Industry inputs

`petSittingInvoice(input)` accepts pets and service rows (visit, walk, overnight, additional pet, holiday or other). It supplies default descriptions and units, but never assumes a price. `cleaningInvoice(input)` accepts a property description and service rows (standard, deep, move-out, oven, refrigerator, windows or other), with job, hour or visit units. Both return canonical invoices using the same validation and calculation rules. Custom descriptions override preset labels.

`petSittingSchema` and `cleaningSchema` expose structural validation for forms. Final validation goes through the adapters, which also enforce cross-field and arithmetic constraints; parsing any schema (including `invoiceSchema`) alone is not sufficient to enable a download or run an operation.

The separate `@sanoma-ai/invoices/examples` entry point exports fictional `petSittingExample` ($180), `residentialCleaningExample` ($240) and `commercialCleaningExample` ($960) inputs. Commercial cleaning uses the cleaning adapter with visits and distinct billing/service addresses; there is no third invoice engine.

## Errors and boundaries

Calculation and adapter failures throw `InvoiceValidationError`, with `code: "invalid_invoice"` and serializable `issues: { code, path, message }[]`. Paths identify fields, including row indices. Adapters map calculation paths back to their `services` rows. Errors do not include submitted field values. Unexpected programming failures are not converted to validation errors.

The package performs no persistence. A browser consumer can keep form state in memory and use native autocomplete; saving data or arranging automation belongs to a separate Sanoma experience. PDF rendering and the browser editor are separate follow-up surfaces, not implemented by this model package yet.

## Development

From the repository root, run `pnpm exec vitest run packages/invoices/test`, `pnpm --filter @sanoma-ai/invoices build`, and the root typecheck, lint and format checks. The tests use no database.
