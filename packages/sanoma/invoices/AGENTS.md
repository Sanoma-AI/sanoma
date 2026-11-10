# Working on sanoma/invoices

An invoice's shape, its arithmetic and its PDF: `sanoma/invoices` (`src/index.ts`) and `sanoma/invoices/pdf` (`src/pdf.ts`). The [README](README.md) has the contract, the rounding rules and the PDF's limits.

## Contents

| Path                                   | What it is                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/schema.ts`](src/schema.ts)       | `invoiceSchema` and its parts, and the types                                                                                                       |
| [`src/calculate.ts`](src/calculate.ts) | `calculateInvoice` (exact decimal arithmetic), `formatMoney` and `InvoiceValidationError`                                                          |
| [`src/index.ts`](src/index.ts)         | `sanoma/invoices`: the two above, zod only                                                                                                         |
| [`src/logo.ts`](src/logo.ts)           | `validateLogo`: a bounded, sanitized PNG                                                                                                           |
| [`src/pdf.ts`](src/pdf.ts)             | `sanoma/invoices/pdf`: the PDF's limits and checks (glyphs, bounds, the logo, the file name), the document in `createElement`, and `renderInvoice` |
| [`test/`](test/)                       | The arithmetic and validation, the PDF in Node and in a Vite browser build, and a workflow that renders and emails one                             |

## Boundaries

- Stateless and local: no clock, I/O, vendor, persistence or ambient date. A workflow and a site import it as plain functions (`LOCAL_ENTRIES` in `sanoma/workflows/shared`, which the workflow lint, the shipped `oxlint.json` and the site build read); it is never a connector and never a built-in `sanoma.*` operation.
- One shape, no trade: a trade's line items and labels are a company's data or an app's, never here.
- `sanoma/invoices` imports zod alone. `sanoma/invoices/pdf` imports React-pdf only inside `renderInvoice` (`await import`): a workflow's file that imports it loads no PDF engine where the worker loads it, `@react-pdf/renderer` stays an optional peer, and the Worker's bundle leaves it out (`OPTIONAL` in `app/src/bundle-build.ts`). One `renderInvoice` serves Node and the browser: React-pdf's `browser` field picks its build, and `pdf().toBlob()` is in both.
- No JSX: the worker loads this package's source through `sanoma-source` with Node's type stripping, which reads no `.tsx`. Styles are a plain object (React-pdf's `StyleSheet.create` returns its argument), so nothing calls the renderer as the module loads.
- Keep validation in front of every render, and the inherited-line-height regression (the comment on `styles.page`) covered by the multipage test.

## Checks

`pnpm vitest run packages/sanoma/invoices`. `workflow.test.ts` starts a worker, so it needs Postgres; `browser.test.ts` builds with Vite and runs the browser bundle's render in Node against the Node build's.
