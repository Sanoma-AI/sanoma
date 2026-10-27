# Working on @sanoma-ai/connector-cloudflare

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the two types, [the Worker](README.md#the-worker), scale to zero, credentials and errors.
- [Source map](src/AGENTS.md): definitions, the operations over `CloudflareApi`, driver, the image's copy into the account's registry, fake, and the Worker's loader.
- [Test map](test/AGENTS.md): the Worker's code, the driver over fixtures, features, both kits on the fake, and the live run.

`worker/` is the Worker the package uploads, plain JavaScript: keep `instance.js` free of imports so the fake runs it in Node, and keep `instance.d.ts` in step with its exports, which `src/worker.ts` re-exports for the rest of the package. A change of the Worker's bindings or routes changes `src/ops.ts` with it. Both the driver and the fake go through `containerOps` and `alarmOps` in `src/ops.ts`: put behavior there, not in either.

The fixtures are written from Cloudflare's API reference, not recorded (README, [Testing the driver](README.md#testing-the-driver)); a recording replaces them. Never put a token or an account id in a fixture.

Run `pnpm vitest run connectors/cloudflare` (the kits need Postgres, `pnpm db:up`) and `pnpm typecheck`. `test/live.ts` runs against a real account by hand only.
