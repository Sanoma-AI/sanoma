# Invoice connector source

| File                   | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `connector.ts`         | Shared input schemas, bounded JSON file result and operation declaration |
| `generate.ts`          | Normalize industry input, call the portable renderer and map errors      |
| `driver.ts`, `fake.ts` | Live and scenario setup around that same computation                     |
| `steps.ts`             | Invoice-specific Gherkin expectations                                    |
| `index.ts`             | Public connector with its setup attached                                 |

Base64 and logo options are opaque ledger fields, not omitted from durable checkpoints. Keep the result self-contained; do not introduce implicit storage or expiring URLs.
