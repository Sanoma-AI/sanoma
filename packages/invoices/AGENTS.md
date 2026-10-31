# invoices

`@sanoma-ai/invoices`: portable invoice schemas, exact calculations and industry adapters. Read [README.md](README.md) for the input contract and rounding rules.

| Path                                    | Purpose                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| `src/schema.ts`                         | Canonical runtime schema and serializable types                     |
| `src/calculate.ts`                      | Exact decimal arithmetic, totals, money formatting and field errors |
| `src/industries.ts`                     | Pet-sitting and cleaning inputs mapped into the canonical model     |
| `src/examples.ts`                       | Fictional fixtures exported separately for consumers                |
| `src/pdf.tsx`                           | Shared React document, including validated public component/factory |
| `src/browser.ts`, `src/node.ts`         | Environment-specific byte rendering over the same document          |
| `src/render-contract.ts`, `src/logo.ts` | PDF limits, glyph checks, errors and bounded PNG sanitization       |
| `test/pdf.test.ts`                      | Real PDF extraction, pagination and input-limit tests               |
| `scripts/browser-smoke.ts`              | Packed-package browser/Node equivalence and timing proof            |
| `test/invoices.test.ts`                 | Arithmetic, validation and cross-industry contract tests            |

Keep the root entry browser-independent and free of I/O, ambient dates and persistence. Industry adapters supply labels and metadata, never duplicate calculation rules. Keep exports aligned with root TypeScript and Vitest mappings. Run the tests and package build described in the README after changing the model.

Keep validation on every public PDF entry point. Browser imports must not pull in Node modules or fetch external assets. Keep the React-pdf inherited-line-height regression covered by the multipage/footer tests. After renderer or export changes, run the packed browser smoke check as well as the tests; see the README for Chrome setup and measurement limits.

`docs/invoice-preview.png` is the README preview of the pet-sitting fixture. Regenerate it from the packed browser smoke output after changing the layout (render the first PDF page to a 1000px-high PNG). It ships with the package so the README image remains valid.
