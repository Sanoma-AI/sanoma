# @sanoma/connector-resend

[Resend Broadcasts API](https://resend.com/docs/api-reference/broadcasts) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-resend
```

| Operation                 | Effect  | What it does                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `resend.broadcast.create` | `write` | Create a broadcast to an audience. Nothing is sent.                  |
| `resend.broadcast.send`   | `send`  | Send a broadcast to every contact in its audience. Cannot be undone. |

```ts
import { resend } from "@sanoma/connector-resend";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [resend.broadcast.create, resend.broadcast.send],
  run: async (ctx, input) => {
    const email = await ctx.resend.broadcast.create({ audience: "newsletter", subject: input.title, html: input.body });
    return ctx.resend.broadcast.send({ id: email.id });
  },
});
```

This package declares the operations only. A driver that calls Resend is not included yet; for tests, use the fakes in `@sanoma/testing`.

License: Apache-2.0.
