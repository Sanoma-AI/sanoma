# @sanoma/connector-bluesky

[Bluesky](https://docs.bsky.app/docs/advanced-guides/posts) (AT Protocol) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-bluesky
```

| Operation             | Effect    | What it does                                                |
| --------------------- | --------- | ----------------------------------------------------------- |
| `bluesky.post.create` | `publish` | Post publicly to the account's feed (up to 300 characters). |

```ts
import { bluesky } from "@sanoma/connector-bluesky";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [bluesky.post.create],
  run: async (ctx, input) => ctx.bluesky.post.create({ text: input.text }),
});
```

This package declares the operations only. A driver that calls Bluesky is not included yet; for tests, use the fakes in `@sanoma/testing`.

License: Apache-2.0.
