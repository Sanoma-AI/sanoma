---
title: Preview site edits locally
description: Run your company site locally, see edits as you save, and check what visitors see on a public site.
sidebar:
  order: 2
---

Run `sanoma` from the company repo. When the repo has a site and the app listens on the local machine, Sanoma serves the app and its sites through Vite’s development server. The usual login applies. You can start editing without waiting for a site build.

With one site named `hello`, Sanoma prints this line at startup.

```text
serving the app with 1 site (hello) from Vite's dev server: edits show as they are saved
```

## What updates live

- **Edit an existing page.** Open the page in your browser, change its site file, and save. The open page updates in place and keeps its state. The server renders the change on the next request.
- **Edit Markdown content.** Save the file under `content/`. Sanoma regenerates `.sanoma/content.ts`. Pages that read the file show the change on their next render, including edits to drafts.
- **Add a page or site.** Save the first route file. Sanoma regenerates the route tree and reloads open pages. Tailwind classes in new files work with both the app stylesheet and [the site’s own stylesheet](/sites/stylesheet/).

## Restarts, hosts and public sites

To preview a [public site](/sites/public-sites/) as a visitor, open the address that `sanoma` prints for it, such as `www: http://www.localhost:3000`. A site declared with `defineSite({ public: true })` appears at the root of `<name>.localhost` on the app’s port. Browsers resolve this address locally. Public pages update as you save. The `sanoma serve` and `sanoma app` commands also print public site addresses at startup.

Run `sanoma check` alongside the dev server to check your work. It builds with the same route options and leaves the dev server’s route tree in place.

If the generated `sites/__virtual.ts` changes, restart `sanoma`. The route generator reads that file once at startup. Leave edits to this file to Sanoma.

If `SANOMA_APP_HOST` names a nonlocal host, `sanoma` builds the sites and serves that build, as `sanoma app` does. Live updates require a local host.
