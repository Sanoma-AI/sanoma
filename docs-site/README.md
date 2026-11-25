# Sanoma's docs site

The site at [docs.sanoma.work](https://docs.sanoma.work), on [Astro Starlight](https://starlight.astro.build). It keeps the layout of Starlight's own template (`npm create astro@latest -- --template starlight`): `astro.config.mjs`, `src/content.config.ts`, `src/content/docs`, `src/assets`, `public`, so Starlight's guides and upgrades apply as written. What it adds is listed below. It is private, never published to npm, and no package of the repository's workspace: it installs on its own, with its own lockfile ([`pnpm-workspace.yaml`](pnpm-workspace.yaml) says why), so nothing at the root builds, checks or publishes it but the reference's test.

## Where the pages are

- **The guides** are [`src/content/docs`](src/content/docs), where Starlight looks for them. A page is Markdown with a `title`, a `description` and its `sidebar.order` in its folder; a page that uses a component (`Tabs`, `Steps`, `LinkCard`) is `.mdx`. A link to another page is its address on the site (`/sites/content/#slugs`), and a link to a file of the repository is its GitHub URL.
- **The connector reference** (`/reference/connectors/`) is drawn from the connectors' own source: [`scripts/reference.ts`](scripts/reference.ts) imports every connector under `connectors/` and writes each operation's effect, description and its input and output as JSON Schema to `src/data/reference.json` (ignored by git), which `src/pages/reference/connectors` and [`src/components/Schema.astro`](src/components/Schema.astro) draw. Nothing there is written by hand.
- **The look** is [`src/styles/sanoma.css`](src/styles/sanoma.css): the website's colours and type on Starlight's variables.
- **Section icons** appear beside homepage card labels and section page titles. To change a section’s icon in both places, update [`SectionIcon.astro`](src/components/SectionIcon.astro).

## Run it

```sh
pnpm install                    # at the root: the connectors the reference reads
pnpm --dir docs-site install    # the site's own packages
pnpm --dir docs-site dev        # the site on a local port, reloading as a page changes
pnpm --dir docs-site build      # the static site in docs-site/dist
pnpm --dir docs-site preview    # serves that build, with search
```

`dev` and `build` write the reference first. The build fails on a link to a page or heading that is not there (`starlight-links-validator`), and writes `/llms.txt`, `/llms-full.txt` and `/llms-small.txt` beside the pages. Search (Pagefind) works in the build, not in `dev`.

## Deploy

[`docs-site.yml`](../.github/workflows/docs-site.yml) builds the site on pull requests that change it, and deploys it to Cloudflare once the Release workflow has published, from the commit it published, so the site describes a release that is on npm. It can also be run by hand, from `main` or a release branch. The site is the Worker `sanoma-docs`, serving `dist` as static assets at `docs.sanoma.work` ([`wrangler.jsonc`](wrangler.jsonc)); `wrangler deploy` creates the Worker, the custom domain and its DNS record if they are missing. The deploy needs the repository's `CLOUDFLARE_ACCOUNT_ID` secret and a `CLOUDFLARE_API_TOKEN` with Workers Scripts edit on the account and Workers Routes and DNS edit on the `sanoma.work` zone; without the secrets it builds and deploys nothing. To deploy by hand, run `pnpm build` then `pnpm exec wrangler deploy` here with those two in the environment.
