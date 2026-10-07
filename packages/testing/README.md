# @sanoma/testing

Fake vendors for testing [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows) workflows without vendor accounts.

```sh
npm install --save-dev @sanoma/testing
```

`fakeMarketingVendors()` returns in-memory drivers for the operations in `@sanoma/connector-ghost`, `@sanoma/connector-resend` and `@sanoma/connector-bluesky`. Each call is recorded, so a test can check what a workflow did.

```ts
import { bluesky } from "@sanoma/connector-bluesky";
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeMarketingVendors } from "@sanoma/testing";
import { startWorker } from "@sanoma/workflows";
import announce from "./workflows/announce.ts";

const vendors = fakeMarketingVendors();
const worker = await startWorker({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers: vendors.drivers,
  databaseUrl: process.env.DATABASE_URL!,
});

// ...start a run and wait for it to finish, then:
console.log(vendors.state.calls.map((c) => c.op));
// ["ghost.post.create", "resend.broadcast.create", ...]
vendors.reset();
```

Pass `{ file }` to keep the fake state in a JSON file. The state then survives a worker restart, and another process can read it.

Status: early (0.x). License: Apache-2.0.
