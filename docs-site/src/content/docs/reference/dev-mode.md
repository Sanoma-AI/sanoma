---
title: Dev mode
description: "When the repo's nodemodules/sanoma or any nodemodules/@sanoma-ai/ is a link into a sanoma checkout (pnpm link), or SANOMADEVREPO names one, sanoma runs sanoma serve --dev in a child process (serving t."
sidebar:
  order: 3
---

When the repo's `node_modules/sanoma` or any `node_modules/@sanoma-ai/*` is a link into a sanoma checkout (`pnpm link`), or `SANOMA_DEV_REPO` names one, `sanoma` runs `sanoma serve --dev` in a child process (serving the [sites](/sites/developing/) as `sanoma` does) and, in the directory of every linked package, its `pnpm run watch` (each package's own watch build: for `sanoma`, `tsc -b --watch` of its parts and `vite build --watch` of the app). A change under any `dist/` a linked package ships (`sanoma`'s own, `workflows/dist`, `app/dist` and the rest, but `testing/dist` and `dev/dist`, which a running company never loads) restarts the child, after three quarters of a second of quiet (with sites, except the app's own pages in `app/dist/client` and `app/dist/server`: the dev server serves the app's source from the checkout and hot-updates it), one restart at a time; a child that exits on its own is reported and started again on the next change.

The child and each watch run in a process group of their own, so a terminal's ctrl-c reaches `sanoma` alone, which then ends each group (SIGTERM, SIGKILL after 5 seconds) and exits. It does the same, saying `dev mode: the repo no longer links <checkout>; stopping`, once none of the repo's links into the checkout is left (`sanoma dev unlink`, an install; `node_modules` is looked at every second, and a link gone on two looks in a row is gone), so the checkout's server writes nothing more into the repo's `.sanoma/app` beside the installed sanoma.

[`sanoma dev link`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/dev/README.md) links `sanoma` and every declared `@sanoma-ai/*` package the checkout has.
