# invoices

`@sanoma-ai/invoices`: portable invoice schemas, exact calculations and industry adapters. Read [README.md](README.md) for the input contract and rounding rules.

| Path                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `src/schema.ts`         | Canonical runtime schema and serializable types                     |
| `src/calculate.ts`      | Exact decimal arithmetic, totals, money formatting and field errors |
| `src/industries.ts`     | Pet-sitting and cleaning inputs mapped into the canonical model     |
| `src/examples.ts`       | Fictional fixtures exported separately for consumers                |
| `test/invoices.test.ts` | Arithmetic, validation and cross-industry contract tests            |

Keep the root entry browser-independent and free of I/O, ambient dates and persistence. Industry adapters supply labels and metadata, never duplicate calculation rules. Keep exports aligned with root TypeScript and Vitest mappings. Run the tests and package build described in the README after changing the model.
