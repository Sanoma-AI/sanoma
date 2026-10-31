# @sanoma-ai/connector-invoices

Generate invoice PDFs locally through Sanoma's normal workflow operations. Pet sitting and cleaning use the same model, calculation and React PDF document as the portable browser renderer. No account, credentials or network connection is needed to generate a PDF.

```sh
pnpm add @sanoma-ai/connector-invoices
```

Register `invoices` in the company's `connectors` and declare the operation in the workflow's `uses`:

```ts
// sanoma.config.ts
import { defineConfig } from "sanoma";
import { invoices } from "@sanoma-ai/connector-invoices";
import generateInvoice from "./workflows/generate-invoice.ts";

export default defineConfig({ workflows: [generateInvoice], connectors: [invoices] });
```

```ts
// workflows/generate-invoice.ts
import { defineWorkflow } from "sanoma";
import { invoices } from "@sanoma-ai/connector-invoices";

export default defineWorkflow({
  name: "generate-invoice",
  trigger: "manual",
  input: invoices.pdf.generate.input,
  uses: [invoices.pdf.generate],
  run: async (ctx, input) => ctx.invoices.pdf.generate(input),
});
```

A pet-sitting request:

```json
{
  "document": {
    "kind": "pet-sitting",
    "invoice": {
      "number": "PET-001",
      "issuedOn": "2026-10-30",
      "currency": "USD",
      "issuer": { "name": "Clover Pet Care" },
      "recipient": { "name": "Alex Morgan" },
      "pets": ["Milo"],
      "services": [{ "service": "visit", "quantity": "5", "unitPrice": "25" }]
    }
  }
}
```

`document.kind` selects `"invoice"` (canonical line items), `"pet-sitting"` (pets and services), or `"cleaning"` (property and services). Residential and commercial cleaning use the same schema. Optional `options.logo` accepts a bounded inline PNG. The [portable package](../../packages/invoices/README.md) owns the input, pricing, font, layout and asset rules; quantities and money are decimal strings. Callers provide invoice numbers and dates explicitly.

## Operation and result

`invoices.pdf.generate` has effect `read`: it computes a document without changing a business record or contacting a vendor. It is idempotent because repeating that computation has no external effect. Normal policy admission, graph representation and durable checkpoints apply. Its target is `invoice/<URL-encoded invoice number>`; the number is caller supplied and is not a globally unique invoice identity.

The result contains `mediaType: "application/pdf"`, a sanitized `filename`, `byteLength`, `base64`, `currency`, and `summary` (safe integer minor-unit totals and currency precision). It is JSON-safe, with no `Blob`, object URL, stream or expiring download link. A later connector operation can accept the result as its input. In that operation's **Node driver**, decode the content for the destination's API:

```ts
import type { PdfFile } from "@sanoma-ai/connector-invoices";

function attachment(file: PdfFile) {
  return {
    filename: file.filename,
    contentType: file.mediaType,
    content: Buffer.from(file.base64, "base64"),
  };
}
```

This helper constructs an attachment; it does not send or store it. Storage and delivery belong in separate declared operations with their own policy checks and retry rules. Numbering, service claiming, payment and invoice records are also outside generation.

Workflow results are limited to **1 MiB of decoded PDF** and **1,400,000 bytes of result JSON**. Base64 takes `4 × ceil(byteLength / 3)` characters (up to 1,398,104), plus bounded metadata. These limits are stricter than the portable renderer's 5 MiB limit because the workflow persists the result in checkpoints. There is no automatic upload or storage fallback. Runtime checkpoint wrappers and other workflow inputs/results add storage beyond this per-result limit.

Generation creates no external invoice record or file, but Sanoma persists workflow inputs and results for execution and recovery. The operation ledger masks `base64` and `options`; other invoice fields remain normal ledger data. A workflow that returns the whole file also includes it in its final result. The free browser tool's memory-only behavior does not imply that workflow execution is stateless.

A completed checkpoint returns its exact stored bytes after recovery. Re-rendering is safe, but PDF byte identity across renders or package versions is not promised.

## Errors

Structural schema failures are rejected by the runtime as invalid input before rendering. Driver validation errors use non-retryable `DriverError` with `vendorCode: "invalid_invoice"` and status 422. Size failures use `output_too_large`; other renderer failures use `render_failed`. None is automatically retried: waiting cannot repair an invalid document. Messages do not include raw PDF content or unexpected renderer error details.

## Testing

`invoicesDriver` is available at `/driver`. `fakeInvoices` at `/fake` runs the **real generator**, with Sanoma's usual call log, idempotency-key replay and fault injection; it never fabricates successful PDF content. The attached step `an invoice PDF was generated for {string}` checks the invoice number.

`pnpm vitest run connectors/invoices` covers all input kinds, real PDF output, malformed assets, size bounds, non-retryable errors, and the packaged Gherkin features on both driver and fake. There are no HTTP recordings because generation is local. Workflow tests additionally need an isolated Postgres test database and exercise author lint, graph output, policy refusal, sandbox execution and checkpoint recovery without re-rendering.

The document icon in `logo.svg` is original artwork for this package.
