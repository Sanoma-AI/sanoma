# @sanoma/connector-ghost

[Ghost Admin API](https://ghost.org/docs/admin-api/) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-ghost
```

| Operation            | Effect    | What it does                                             |
| -------------------- | --------- | -------------------------------------------------------- |
| `ghost.post.create`  | `write`   | Create a draft post. Drafts are not visible on the site. |
| `ghost.post.publish` | `publish` | Publish a draft post on the site. Idempotent.            |

```ts
import { ghost } from "@sanoma/connector-ghost";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, input) => {
    const post = await ctx.ghost.post.create({ title: input.title, html: input.body, status: "draft" });
    return ctx.ghost.post.publish({ id: post.id });
  },
});
```

This package declares the operations only. A driver that calls Ghost is not included yet; for tests, use the fakes in `@sanoma/testing`.

License: Apache-2.0.
