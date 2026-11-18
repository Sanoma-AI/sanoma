---
title: Demos
description: "sanoma demo --out <dir> builds the repo's sites as a demo."
sidebar:
  order: 11
---

`sanoma demo --out <dir>` builds the repo's sites as a demo: static files that render them into an element of any page, running each workflow a site calls in the browser, every vendor on its connector's fake, every collection in memory, from the world `scenarios/world.feature` seeds (one Scenario of Givens), so a visitor tries the real pages with no server and no request leaving the page. Put it in a site's `public/` folder (`sites/www/public/demos/invoicing/`, every URL in it relative) and mount it from a page:

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

- `mount(element, { path, exit })` resolves to the unmount. `path` is the page shown first, as the app has it (`/sites/<site>/…`, an app's site's `/sites/<app>/<site>/…`; the first site's home unless given), on a history of the demo's own: the host's URL and history never move. `exit` is called with the path a link leads to outside the sites (an app page's) instead of going there. Each mount starts from the world again. A `mount` called on an element while an earlier one there still seeds wins: the earlier renders nothing. A page may mount several demos, but `api` is one: the runtime of the last `mount` seeded and still mounted answers it. Mount at most one demo whose pages call `api`.
- `demo.css` holds Tailwind's theme and utilities, the kit's look and the sites' own stylesheets (a route's `import css from "../style.css?url"` too), never preflight, every rule scoped to the element (`[data-sanoma-demo]`, which `mount` sets on it). The element is the demo's document: it has the light theme's background, type and colour, and the kit's dark styles stay off, whatever the host's theme. A site's `toast` shows at the window's corner, as in the app (at a transformed element's, when one is around the demo), with the stylesheet Sonner adds to the page's head. Its rules are in Tailwind's layers, which a host's unlayered rules for `h1`, `a` or `button` win over: keep those in layers.

## Runs and what the build refuses

- Every approval a run asks for is approved at once, by its approver. A `ctx.sleep` waits as it does in the app: a run that waits a week stays at its sleep, running, and what follows the sleep happens only once the week has passed with the page still open. The unmount drops the demo's runs and their timers. Who calls is `anonymous`. The page carries the description of the workflows it runs, their operations and the repo's collections and apps, never its policies, secrets, connections, resources or login.
- The build refuses, each at its file: a workflow a site calls that is defined in `sanoma.config.ts` rather than its own file under `workflows/`; a call to the app's own operations (`sanoma.*`); a collection a site reads that no data file under `resources/` exports; a vendor whose connector has no fake, or names no package (`info.package`) for the page to import it from; a world the fakes cannot take (with the world's own message); a folder holding files no demo writes; and a page that would load what only a server has (Node's modules, DBOS, `pg`, Drizzle). `sanoma/invoices/pdf` (and `@react-pdf/renderer`, when the repo installs it) is bundled for the browser, loaded when a page imports it.
