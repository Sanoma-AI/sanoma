# Working on @sanoma-ai/connector-cloudflare

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the three types, [the Worker](README.md#the-worker), scale to zero, [DNS records](README.md#dns-records), credentials and errors.
- [Source map](src/AGENTS.md): definitions, the operations over `CloudflareApi` (the record sets' in `records.ts`), driver, the image's copy into the account's registry, fake, and the Worker's loader.
- [Test map](test/AGENTS.md): the Worker's code, the driver over fixtures, features, both kits on the fake, and the live run.

`worker/` is the Worker the package uploads, plain JavaScript: keep `instance.js` free of imports so the fake runs it in Node, and keep `instance.d.ts` in step with its exports, which `src/worker.ts` re-exports for the rest of the package. A change of the Worker's bindings or routes changes `src/ops.ts` with it. The custom domains Sanoma may detach are the ones the Worker's own bindings record, `SANOMA_DOMAINS` (the sites') and `SANOMA_HOSTNAME` (the app's, which `SANOMA_HOST_URL` and the state's `url` follow): never detach one they do not name. Both the driver and the fake go through `containerOps` and `alarmOps` in `src/ops.ts` and `recordsOps` in `src/records.ts`: put behavior there, not in either. A record set owns only the records carrying its comment, `sanoma:<zone>/<name>`: never change or delete another, except adopting one identical to a declared record in type, name, content (and an MX record's priority) that is not proxied and carries no other set's mark.

The fixtures are written from Cloudflare's API reference, not recorded (README, [Testing the driver](README.md#testing-the-driver)), the `records-*` ones too until a live run on `sanoma.work` records them; a recording replaces them. Never put a token or an account id in a fixture.

Run `pnpm vitest run connectors/cloudflare` (the kits need Postgres, `pnpm db:up`) and `pnpm typecheck`. `test/live.ts` runs against a real account by hand only.
