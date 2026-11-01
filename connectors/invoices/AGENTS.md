# Working on @sanoma-ai/connector-invoices

Local PDF generation through an ordinary Sanoma operation. Read [README](README.md) for usage, result limits and persistence, then the [source](src/AGENTS.md) or [test](test/AGENTS.md) map.

- Share schemas, industry normalization, money calculation and rendering with `@sanoma-ai/invoices`; never reimplement them here.
- Load the PDF engine only when called. This connector needs no account, credentials or network.
- Live and fake execution use the same generator. Keep errors non-retryable for invalid input, unsupported content and size limits.
- Generation does not assign invoice numbers, save invoice records, send files or collect payments. Runtime checkpoints still persist the result.
- Check with `pnpm vitest run connectors/invoices`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build`. Workflow tests need their own `SANOMA_TEST_DATABASE_URL` on port 5433.
