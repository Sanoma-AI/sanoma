---
title: Developing a site
description: "sanoma serves the app and the sites from Vite's dev server instead of a build (serving the app with 1 site (hello) from Vite's dev server."
sidebar:
  order: 2
---

`sanoma` serves the app and the sites from Vite's dev server instead of a build (`serving the app with 1 site (hello) from Vite's dev server: edits show as they are saved`), behind the same login, and writes no build:

## What updates live

- An edit to a site's file shows in the open page as it is saved, without a reload, the page's state kept (hot module replacement); the server's render of the page follows on the next request.
- A file saved under `content/` shows on the next render of a page that reads it, drafts included, with no restart, and `.sanoma/content.ts` is written again.
- A new page, or a new site folder, is live once its first route file is written: the route tree is regenerated and open pages reload, with no restart. A Tailwind class in a new file is styled too, by the app's stylesheet and by a site's own ([`sanoma/app`'s A site's own stylesheet](/sites/stylesheet/)).

## Restarts, hosts and public sites

- A change to `sites/__virtual.ts` itself needs a restart: the route generator loads that file once. `sanoma` writes it; never edit it.
- `sanoma check` beside it builds the app with the same route options, so it leaves the dev server's route tree alone.
- The dev server listens on this machine only: with `SANOMA_APP_HOST` naming another, `sanoma` builds the sites and serves the build, as `sanoma app` does.
- A public site (`defineSite({ public: true })`) answers at the root of `<name>.localhost` on the app's port, with hot updates too, as its visitors see it ([public sites](/sites/public-sites/)); `sanoma`, `sanoma serve` and `sanoma app` print each one's address after they start (`www: http://www.localhost:3000`). Browsers send `*.localhost` to this machine with no setup.
