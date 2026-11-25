---
title: Demos
description: "Build and embed a static demo that runs site workflows in the browser with fake vendors."
sidebar:
  order: 11
---

Run `sanoma demo --out <dir>` to build an embeddable version of the repo’s sites. Workflows run in the visitor’s browser against connector fakes and in-memory collections. One scenario of Given steps in `scenarios/world.feature` supplies their starting data. The visitor can try the pages without a running Sanoma server or calls to vendors.

Write the output to a site’s `public/` directory, such as `sites/www/public/demos/invoicing/`. All demo URLs are relative. Mount the demo in an element on the page as shown below.

```tsx
// sites/www/routes/invoicing.tsx: the demo, in a page of the public site.
import { useEffect, useRef } from "react";

function Demo() {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const url = "/demos/invoicing/mount.js";
    const mounting = import(/* @vite-ignore */ url).then(({ mount }) =>
      mount(element.current, { path: "/sites/invoicing/invoicing", exit: () => location.assign("/start") }),
    );
    return () => void mounting.then((unmount: () => void) => unmount());
  }, []);
  return (
    <>
      <link rel="stylesheet" href="/demos/invoicing/demo.css" />
      <div ref={element} />
    </>
  );
}
```

## Mounting and styling

- `mount(element, { path, exit })` resolves to the unmount. `path` is the page shown first, as the app has it (`/sites/<site>/…`, an app's site's `/sites/<app>/<site>/…`; the first site's home unless given), on a history of the demo's own: the host's URL and history never move. `exit` is called with the path a link leads to outside the sites (an app page's) instead of going there. Each mount starts from the world again. A `mount` called on an element while an earlier one there still seeds wins: the earlier renders nothing.

  A page may mount several demos, but `api` is one: the runtime of the last `mount` seeded and still mounted answers it. Mount at most one demo whose pages call `api`.

- `demo.css` holds Tailwind's theme and utilities, the kit's look and the sites' own stylesheets (a route's `import css from "../style.css?url"` too), never preflight, every rule scoped to the element (`[data-sanoma-demo]`, which `mount` sets on it). The element is the demo's document: it has the light theme's background, type and colour, and the kit's dark styles stay off, whatever the host's theme. A site's `toast` shows at the window's corner, as in the app (at a transformed element's, when one is around the demo), with the stylesheet Sonner adds to the page's head.

  Its rules are in Tailwind's layers, which a host's unlayered rules for `h1`, `a` or `button` win over: keep those in layers.

## Runs and what the build refuses

- **Runs in the browser.** Calls act as `anonymous`. Approvals resolve immediately as the designated approver. A `ctx.sleep` still waits for the requested duration. A week-long sleep needs the page to stay open for a week. Unmounting the demo discards its runs and timers. The bundle carries descriptions of its workflows, operations, collections, and apps. Policies, secrets, connections, resources, and login configuration stay out of the bundle.
- The build refuses, each at its file: a workflow a site calls that is defined in `sanoma.config.ts` rather than its own file under `workflows/`; a call to the app's own operations (`sanoma.*`); a collection a site reads that no data file under `resources/` exports; a vendor whose connector has no fake, or names no package (`info.package`) for the page to import it from; a world the fakes cannot take (with the world's own message); a folder holding files no demo writes; and a page that would load what only a server has (Node's modules, DBOS, `pg`, Drizzle).

  `sanoma/invoices/pdf` (and `@react-pdf/renderer`, when the repo installs it) is bundled for the browser, loaded when a page imports it.
