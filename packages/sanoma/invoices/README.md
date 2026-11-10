# sanoma/invoices

An invoice's shape, its arithmetic and its PDF, for a [Sanoma](https://github.com/Sanoma-AI/sanoma) workflow, a site and a test alike. It is plain computation over the values you give it: no clock, no vendor, no database, and nothing stored. It numbers, sends, stores and collects nothing; a workflow does that with its connectors. It knows one shape of invoice and no trade: the line items a trade bills for are your data.

- `sanoma/invoices`: the schema and its types, `calculateInvoice`, `formatMoney` and `InvoiceValidationError`. Zod only.
- `sanoma/invoices/pdf`: `renderInvoice`, which makes the PDF file, the same in Node and in a browser. It needs `@react-pdf/renderer`, an optional peer: install it beside `sanoma` in a company that makes PDFs (`pnpm add @react-pdf/renderer`). A company that never imports `sanoma/invoices/pdf` needs nothing more.

A workflow imports both as plain functions, and so may a site's page; the lint allows them in either.

```ts
// workflows/send-invoice.ts
import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow, z } from "sanoma";
import { invoiceSchema } from "sanoma/invoices";
import { renderInvoice } from "sanoma/invoices/pdf";

export default defineWorkflow({
  name: "send-invoice",
  trigger: "manual",
  input: z.object({ invoice: invoiceSchema, to: z.string() }),
  uses: [resend.emails.send],
  run: async (ctx, { invoice, to }) => {
    const file = await renderInvoice(invoice);
    return ctx.resend.emails.send({
      to,
      from: "Acme <billing@acme.example>",
      subject: `Invoice ${invoice.number}`,
      text: "Your invoice is attached.",
      attachments: [{ filename: file.filename, content: Buffer.from(file.bytes).toString("base64") }],
    });
  },
});
```

## The invoice

`InvoiceInput` holds an explicit invoice number, issue date, issuer, recipient, currency and line items. Each line has a description, a unit (`visit`, `hour`, `night`, `job`, `item` or `charge`), a quantity and a unit price, and may have a service date. Optional fields: a due date, a service period, a service address apart from the billing one, notes, a flat discount, a tax percentage, the amount already paid, and up to 20 `details`, plain-text label and value pairs for whatever else the invoice should say. `invoiceSchema` is the runtime contract; `Invoice` is its output, defaults applied. `schemaVersion` is `1`.

Quantities and amounts are **decimal strings**, never JavaScript numbers, and nothing is coerced: an empty price is invalid, not zero. A quantity is positive, with up to six whole and four decimal digits; a price, discount or payment has up to nine whole and four decimal digits. A discount or payment must fit the currency's minor unit (trailing zeros are fine); a price may have more decimals, since a line is rounded after multiplying by its quantity.

Currencies: USD, EUR, GBP, AUD and CAD (two decimal places), JPY (none) and KWD (three). Locales for formatting: `en-US`, `en-GB`, `de-DE` and `fr-FR`; the locale formats amounts and translates nothing. Dates are `YYYY-MM-DD`, with no time zone; a due date or a service period's end never comes before its start.

`calculateInvoice(input)` validates any value and returns the invoice, its lines and its totals, in safe integer minor units, by exact BigInt arithmetic:

1. Each line is its quantity times its unit price, rounded half up to the currency's minor unit.
2. The rounded lines are summed, and the flat discount subtracted.
3. Tax is the discounted subtotal times the tax percentage, rounded half up once.
4. The total is that plus tax; the balance due is the total less what was paid.

Negative values, a discount over the subtotal, a payment over the total, tax over 100% and amounts past JavaScript's safe integers are refused. Credits, several tax rates, tax-inclusive prices and a jurisdiction's tax rules are not modeled.

`formatMoney(minor, currency, locale?)` formats minor units without passing the amount through a float.

A failure is an `InvoiceValidationError`, `code: "invalid_invoice"`, with serializable `issues: { code, path, message }[]`: each names its field, row indices included, and none carries the value submitted.

## The PDF

`renderInvoice(input, options?)` validates the invoice and returns `{ bytes, mediaType: "application/pdf", filename, summary }`: the file's bytes, a safe file name from the invoice number (`invoice-INV-001.pdf`) and the totals. It loads the renderer at its first call, so a module that imports it (a workflow's file, which the worker loads at its start) loads no PDF engine. In a browser it uses React-pdf's browser build, which a site's bundle picks by itself: load the page that renders on demand, since the renderer is large.

The layout follows `presentation`: `paper` (`A4` or `LETTER`) and `accent` (a six-digit hex color). It repeats the header, the column headings and the page numbers on every page, keeps each line on one page, and lets long notes run on. The PDF's dates are the issue date's, so the same invoice renders the same file with the same renderer: a run that resumes and renders again attaches the bytes it sent before. Another version of React-pdf may change the bytes.

The font is the built-in Helvetica: printable ASCII, Latin-1 and the WinAnsi punctuation in `src/pdf.ts`. Other text, emoji and other scripts among it, is an `unsupported_text` issue. Nothing is fetched at render time.

A logo is `{ logo: { mediaType: "image/png", base64 } }` as the second argument: base64 bytes, never a URL or a data URI, of a non-interlaced 8-bit RGB or RGBA PNG, up to 256 KiB and 1024 pixels a side. Its compressed pixels are bounded before decoding, its CRCs checked and its metadata stripped; color-key transparency (`tRNS`) is refused, so use RGBA.

The PDF is narrower than the schema: at most 100 lines, 30,000 characters of text and 5 MiB, and a line's description within a 40-line budget (about 20 characters a line, newlines kept); longer detail belongs in the notes. Single-line fields refuse tabs and newlines. Each of these is an `InvoiceValidationError`; a failure to render is an `InvoiceRenderError`, `render_failed` or `output_too_large`. Neither returns part of a file. `pdfLimits` and `pdfOptionsSchema` say the limits and the options' shape.
