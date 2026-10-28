# @sanoma-ai/app

A web UI for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces: it renders from `describeConfig(config)`, the config's ledger store and Postgres. The only workflow code it reads is each workflow's `run`, once at start, to draw its outline. It runs no workflows itself. The page talks to the server through TanStack Start server functions, its only HTTP surface besides the login's routes and the GitHub App's manifest flow (`/setup/github/`), and on a [public site's](#public-sites) own host only two of them, `callFn` and `getActor`, beside the site's login's routes and its robots.txt and sitemap; scripts and agents reach the same runs through [`SanomaClient`](https://www.npmjs.com/package/@sanoma-ai/workflows#building-your-own-ui), over the same Postgres.

It is a [TanStack Start](https://tanstack.com/start) app (React, TanStack Router, Query and Form), built into the package and served by `startApp` from Node.

## Usage

```sh
npm install @sanoma-ai/app @sanoma-ai/workflows
```

The [`sanoma`](https://www.npmjs.com/package/sanoma) bin runs the app beside the worker over a repo's `sanoma.config.ts`; `startApp` remains for a custom host. Run it beside the worker, from the same config:

```ts
import { startApp } from "@sanoma-ai/app";
import config from "./sanoma.config.ts";

const app = await startApp(config, { port: 3000 });
console.log(app.url); // http://127.0.0.1:3000
```

`startApp` checks the config first and throws what the worker would refuse (missing credentials refuse nothing: the connector pages show and set them). The worker and the app share the config's Postgres (`databaseUrl`, else `SANOMA_DATABASE_URL`): the runs, the credentials and, by default, the ledger, which `postgresLedger` keeps in a table there, so the app reads what a worker in any process records. A config with a `jsonlLedger` shares its directory instead, and a `memoryLedger` is visible only in the process that wrote it. A run that has started but has no records in the app's ledger says so on its page, since the likeliest cause is an app on another ledger than the worker's (another database, or a `jsonlLedger` directory relative to another working directory). Without `port`, the app takes any free port and reports it in `app.url`. `app.close()` stops it.

## Sites

A company repo's `sites/<name>/routes/` are TanStack Router file routes the app serves under `/sites/<name>/`, inside its shell, and an app's `apps/<app>/sites/<name>/routes/` under `/sites/<app>/<name>/` (the site `<app>/<name>`, its route ids `/sites/<app>/<name>/…`; a public one answers at `<name>.<app>.localhost`). The package ships its source for that, and a Node-only entry, `@sanoma-ai/app/build`, which the `sanoma` bin calls:

```ts
import { buildApp } from "@sanoma-ai/app/build";
import { startApp } from "@sanoma-ai/app";

const { distDir, built } = await buildApp(repo, { log: console.log });
const app = await startApp(config, { distDir });
```

`buildApp(repo)` builds the app's routes and every site as one TanStack Start build with the repo as Vite's root, and writes only under the repo: `.sanoma/app/routeTree.gen.ts`, Vite's cache in `.sanoma/app/vite/`, and the build in `.sanoma/app/build/<key>/` (`client/`, `server/server.js`, and `published.json`, each content kind's published slugs, for the [sitemaps](#public-sites)), where the key covers the app's version and source directory and every file under `sites/` and `content/`. All of `.sanoma/app/` is ignored by its own `.gitignore` (`*`), which Tailwind's scan of the repo honours too, so a build never reads its own output, whatever the repo's `.gitignore` says. A build with the same key is reused (`built: false`), and a new one is built beside it and moved into place, so an app serving the old one keeps it. The server bundle holds everything but the runtime (`@sanoma-ai/workflows`, `@sanoma-ai/bridge`, DBOS, `pg`, `zod`), which it imports by file URL, resolved from `runtimeFrom` (by default this package's own `package.json`), so the worker and the app share one copy.

- A site is client code: a site importing the runtime, a connector, DBOS, `pg` or a `*.server.*` file fails the build with "Import denied".
- A site imports React, TanStack's packages and this app as the app does, from the app's own install: the company repo depends only on `sanoma`.
- A folder is a site when it has `routes/` and its name is one URL segment (`/^[a-z][a-z0-9-]*$/`); `sitesOf(repo)` lists the sites and the refused folders, which the build logs and leaves out. Two pages claiming one path fail the build, naming the path and both files.
- `writeSiteFiles(repo)`, which `buildApp` calls first, writes `sites/__virtual.ts` (the listing the route generator reads; committed, never edited), `sites/tsconfig.json` when missing, `.sanoma/app/tsconfig.json` every time: the app's compiler options (`tsconfig.site.json`, shipped) with its React, TanStack and route tree, so `tsc -p sites/tsconfig.json` checks a site's links against every page; and `.sanoma/content.ts`, the types of [`content`](#content).
- `appViteConfig({ repo, runtimeFrom })` is the build's Vite config; `appViteConfig()` is this package's own (its `vite.config.ts`), the same pipeline with no sites. `appSources()` gives the app's `src` and `tsconfig.site.json` by real path.

`startApp(config, { dev: { repo } })` serves the app and the repo's sites from Vite's dev server instead of a build, behind the same `/healthz` and login: `appDevServer(repo, http)` from `@sanoma-ai/app/build` is the build's Vite config (`appViteConfig({ repo })`, so the route generator's options are the build's) in middleware mode, with hot updates over the app's own HTTP server, and Start's server entry imported for each request and handed the same context. On the server, Vite compiles the app's source and `sanoma` (whose `sanoma/site` and `sanoma/ui` are that source), and leaves the runtime to Node, the copy `startApp`'s context holds. An edit to a site or to the app's source shows without a reload, a Tailwind class in a new file under `sites/` is in the app's stylesheet and each site's own, and a new site folder is live once it has a route file; a change to `sites/__virtual.ts` itself needs a restart. It writes the sites' generated files and Vite's cache under `.sanoma/app/`, and no build. It listens on this machine only: the hot updates' websocket does not pass the login, so `startApp` refuses `dev` with any other `host`. `dev.onFileChange`, when given, is called with each file the dev server's watcher sees added, changed or removed (`sanoma` writes `.sanoma/api.ts` again on a change to what the config is read from).

A company repo is an ES module package (`"type": "module"`, as `sanoma init` writes it): Vite names the server entry `server.mjs` otherwise.

### A site's imports

A site's route file imports `createFileRoute` from `@tanstack/react-router` (the route generator rewrites the path there, and only there) and the rest from `sanoma/site`, which is this package's `@sanoma-ai/app/site`: the app's own router's `Link`, `Outlet`, `useNavigate`, `useParams`, `useSearch`, `useRouter`, `useRouterState`, `getRouteApi`, `linkOptions`, `redirect` and `notFound` (and their types), `defineSite`, `api` with `ApiError` and `errorBodyOf` ([Calling operations and workflows](#calling-operations-and-workflows)), `content`, the repo's Markdown ([Content](#content)), a public site's languages, `defineMessages`, `useMessages`, `useLocale` and `useLocales` ([Languages](#languages)), `siteOrigin` and `siteUrl`, a page's absolute URLs ([Public sites](#public-sites)), and the pieces that talk to the app, `RunForm` and `useActor` ([The kit and RunForm](#the-kit-and-runform)). How a page looks comes from `sanoma/ui`. `sites/<name>/site.ts`, optional, names the site, and may give it an icon, a [Lucide](https://lucide.dev/icons) icon's name as a literal (`icon: "kanban"`), read without running the file (one that is not a literal is no icon):

```ts
// sites/help/site.ts
import { defineSite } from "sanoma/site";

export default defineSite({ title: "Help desk", icon: "life-buoy" });
```

```tsx
// sites/help/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "sanoma/site";

export const Route = createFileRoute("/sites/help/")({ component: Home });

function Home() {
  return <Link to="/workflows">Workflows</Link>;
}
```

`title` names the site in the app (its folder's name without one) and `icon` is its tile's icon in the bar, a [Lucide](https://lucide.dev/icons) icon's name (without one, a globe for a public site and a window for one in the app only). A site for visitors rather than people says so in `site.ts`: `defineSite({ title: "Website", public: true, login: "auth0" })`. `public: true` makes it a public site, served at the root of its own host to visitors; `login`, for a public site only, names the connector in `sanoma.config.ts` whose login half signs a visitor in (`withSetup`'s `login`, in [the workflows README](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), and without it every page runs as `anonymous`. `locales`, for a public site with no login, names its languages ([Languages](#languages)). `sanoma` reads these without running `site.ts`, so the file's default export must be `defineSite({ … })` written out, each a literal; `sanoma check` names what it cannot read or check. A public site is served at the root of its own host too ([Public sites](#public-sites)).

### The kit and RunForm

A site imports how its pages look from `sanoma/ui`, which is this package's `@sanoma-ai/app/ui`: the app's own components, so its pages look like the app's (Tailwind's classes and the theme's tokens apply to a site's files too: `bg-card`, `text-muted-foreground`, `bg-primary/10`; the app's theme has only its tokens, so Tailwind's default palette, `bg-white` or `text-red-500`, generates nothing there, only in [a site's own stylesheet](#a-sites-own-stylesheet) without [the kit's](#the-kit-on-a-site)). It is presentational only: nothing in it talks to the running app (its queries, server functions, actor or config), so it could ship as a package of its own. It is an explicit list, and nothing else of the app is public:

- the shadcn components the app is built from: `Button`, `Input`, `Label`, `Textarea`, `Checkbox`, `NativeSelect`, `Slider`, `Badge`, `Separator`, `Skeleton`, `Spinner`, and the parts of `Field`, `Card`, `Alert`, `Table`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Tooltip`, `DropdownMenu`, `Empty`, `Item`, `ButtonGroup`, `Collapsible`, `Breadcrumb` and `Avatar`; and sonner's `toast`, shown by the app's toaster;
- the app's own pieces: `PageHeader` (a page's `<h1>`, its `title`), `Region`, `Facts` and `Fact`, `Tip`, `ButtonLink`, `ToneBadge` (with `dot`, a status pill), `toneBadge`, `effectBadge`, `StatusDot` (and the `Tone` type), `Notice`, `Nothing`, and `FloatingCard` (the one card with a shadow, for a selection shown over a page's card, placed by its `className`);
- the hook `useDensity` (Compact or not).

What talks to the app comes from `sanoma/site`, beside `api`:

- `RunForm({ workflow })`, the app's start form for a workflow, its fields drawn from the workflow's input schema;
- the hook `useActor()`, who is signed in (`actor`, `groups`, and `signOut` when the login has its own routes; the `ActorState` type).

`RunForm` names the workflow with a link to its page, starts a live run, with the server's complaints shown on the fields they name, and once the run starts stays on the page and links to the run, where its graph, ledger and approvals are. A name the config does not have renders a notice saying so.

```tsx
// sites/launches/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "sanoma/site";
import { Fact, Facts, PageHeader, Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/launches/")({ component: LaunchDesk });

function LaunchDesk() {
  return (
    <>
      <PageHeader title="Launch desk" />
      <Region title="How a launch goes">
        <Facts>
          <Fact label="Draft">A Ghost post, written from the form below</Fact>
          <Fact label="Review">marketing-lead approves the launch copy in the Inbox</Fact>
          <Fact label="Launch">Published at the launch time</Fact>
        </Facts>
      </Region>
      <Region title="Announce a launch">
        <RunForm workflow="announce" />
      </Region>
    </>
  );
}
```

![A site's page in the app: the bar, a Region of Facts and the announce workflow's RunForm](https://github.com/Sanoma-AI/sanoma/raw/main/.github/assets/site.png)

A site's page inside the app's shell: the kit's `Region` and `Facts`, and `RunForm`, from `sanoma/site`, drawing announce's fields from its schema.

With sites, the bar has a tile per site, between Workflows and the Setup group: its `icon` and its title, linking to its first page (its home, when it has one; a site whose every page has a path parameter has none, and no tile), lit on its pages. The build bundles only the Lucide icons the sites' `site.ts` name, so the server renders a site's icon in the page's first paint, and a name Lucide does not have shows the default for its kind. **Data**'s page header leads to **Sites** (`/sites`, the one path under `/sites` no site can take; Data is lit there), which lists each site in a table: its icon and title linking to its home, its app's name for an app's site, its folder, its pages, each named by its route's `staticData.crumb` or its path under the site (a page with a path parameter is left out), and where a public site answers, with its sitemap ([Public sites](#public-sites)). `@sanoma-ai/app/site` and `@sanoma-ai/app/ui` ship as source (`src/site.ts`, `src/ui.ts`), compiled by Vite in the company's build; they hold nothing server-side (a server function is a fetch in the browser).

### A site's own stylesheet

A site styles its pages with Tailwind's classes and the app's tokens, which the app's stylesheet carries (it scans the whole repo, so a site's classes are in it). A site with a look of its own, such as a public site, adds a stylesheet beside its routes and links it from its layout's `head`:

```css
/* sites/www/style.css */
@layer theme, base, components, utilities;
@import "tailwindcss/theme" layer(theme);
@import "tailwindcss/utilities" layer(utilities.www) source("./");
@plugin "@tailwindcss/typography";

.www {
  font-family: Georgia, serif;
  line-height: 1.6;
}

/* On the site's own host only: the visitor's light or dark, and colours that follow it. */
[data-site="www"] {
  color-scheme: light dark;
  background: light-dark(#f5f6f4, #151a1d);
}
```

```tsx
// sites/www/routes/route.tsx
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { NotFound } from "../components/not-found.tsx";
import css from "../style.css?url";

export const Route = createFileRoute("/sites/www")({
  head: () => ({ links: [{ rel: "stylesheet", href: css }] }),
  component: () => (
    <div className="www">
      <Outlet />
    </div>
  ),
  // A path no page has, drawn inside the layout.
  notFoundComponent: NotFound,
});
```

- It imports `tailwindcss/theme` and `tailwindcss/utilities`, not `tailwindcss`: a site's pages are also shown inside the app at `/sites/<name>`, and Tailwind's preflight would restyle the app around them. The site writes its base rules under a class of its own (`.www` above) instead, and rules for its own host under `[data-site="<name>"]`: there the document is `<html data-site="<name>">`, and inside the app it has no `data-site`.
- Its utilities are a layer inside the app's (`utilities.<name>`), scanned from the site's folder only (`source("./")`): inside the app, the app's own utilities win over the site's, so the site's `hidden` leaves the bar's `md:flex` alone. Imported into `utilities` itself, the site's would override the app's responsive variants, and hide the bar. A site that uses components from outside its folder names them for the scan (`@source "../../components";`).
- `tailwindcss` and its `theme`, `utilities` and `preflight` resolve to the app's install, as the app's own stylesheet does: the repo installs nothing for them. A `@plugin` is a package the repo installs itself (`pnpm add @tailwindcss/typography`); what it imports of `tailwindcss` (`tailwindcss/plugin`, `tailwindcss/colors`) resolves to the app's install too.
- Its theme is Tailwind's default, not the app's (until it imports [the kit's](#the-kit-on-a-site)): a class both use where the app's theme differs (`rounded-lg`, `font-sans`) takes the app's value while the page is shown inside the app, and the site's on the site's own host. Its theme variables are another matter: one both name (`--font-sans`, once a site's class uses it) takes the site's value inside the app, in the app's chrome too. A site keeps its own tokens under names the app does not use (`--font-body`, not `--font-sans`), so its classes look the same in both and leave the app's alone.

#### The kit on a site

The kit's look is in the app's stylesheet, which a public site's own host does not load. A site that uses `sanoma/ui` there imports the look into its own stylesheet, after Tailwind's utilities, and gives the kit its colours:

```css
/* sites/www/style.css */
@layer theme, base, components, utilities;
@import "tailwindcss/theme" layer(theme);
@import "tailwindcss/utilities" layer(utilities.www) source("./");
@import "sanoma/ui.css";

/* A colour of the site's own: bg-brand. */
@theme {
  --color-brand: oklch(0.62 0.17 45);
}

/* The kit's colours, by shadcn's names: on the site's own host, and under its class inside the app. */
[data-site="www"],
.www {
  --background: light-dark(oklch(0.98 0.005 80), oklch(0.18 0.01 80));
  --foreground: light-dark(oklch(0.22 0.01 80), oklch(0.95 0.005 80));
  --card: light-dark(oklch(1 0 0), oklch(0.22 0.01 80));
  --secondary: light-dark(oklch(0.94 0.005 80), oklch(0.27 0.01 80));
  --muted-foreground: light-dark(oklch(0.5 0.01 80), oklch(0.72 0.01 80));
  --border: light-dark(oklch(0.9 0.005 80), oklch(0.3 0.01 80));
  --primary: oklch(0.62 0.17 45);
  --primary-foreground: oklch(1 0 0);
}

/* On its own host only: the visitor's light or dark, the page's colours and the kit's font. Inside
   the app, the app's light or dark, which its light-dark() values then follow. */
[data-site="www"] {
  color-scheme: light dark;
}
[data-site="www"] body {
  @apply bg-background font-sans text-foreground;
}
```

- `sanoma/ui.css` brings the kit's classes (Tailwind scans its components where they are installed), its `dark` and `compact` variants, shadcn's and tw-animate's CSS (the `data-open:` variants, the animations), its fonts (IBM Plex Sans and Mono, Fraunces), the app's theme (`bg-primary`, `rounded-lg`, `font-sans`) and the part of preflight its elements need (`src/ui.css`). On the site's own host that part is the whole page's reset, the site's own elements too; inside the app, which loads all of preflight, it changes nothing.
- Its theme turns Tailwind's palette off, as the app's does: `bg-white` generates nothing, and a colour of the site's own is a token in an `@theme` after the import.
- The kit's colours are tokens by shadcn's names (the list is `src/ui.css`), in the theme layer, so any rule of the site's wins. Set them under `[data-site="<name>"]` for the site's own host and under the site's class for its pages inside the app, never on `:root`, which inside the app would recolour the app. A name that is another's there (`--popover` is `--card`, `--ring` is `--primary`) follows the site's value on its own host, but inside the app only when the site sets it too; and inside the app the kit's popups (dialogs, menus, tooltips), drawn outside the site's class, keep the app's colours.
- A `light-dark()` value follows the visitor's light or dark once the site says `color-scheme: light dark`, so a site that follows dark gives one to each surface and text colour it shows (`--card`, `--secondary`, `--muted-foreground`, `--border` above; `--destructive` if it shows errors): a name it leaves keeps the kit's light value. The `dark:` variant, the kit's and the site's own classes' alike once it imports the kit, follows `.dark` on `<html>`, which only the app sets, never a public host: there it never applies, and the tones' and effects' pale badges stay light.

### Calling operations and workflows

`api`, from `sanoma/site`, calls the company's operations and workflows as the person on the page. It is one generic client over one server function (`callFn`, a POST with `{ name, input?, id? }`), so it calls whatever name a path spells; the company's generated `.sanoma/api.ts` types it, by augmenting `Register` (`declare module "sanoma/site" { interface Register { api: … } }`) with `WorkflowFn`, `OpFn` and `CollectionApi`, which `sanoma/site` re-exports with `Saved` and `ListQuery`. Without that file `api` is untyped; `sanoma check` and `sanoma` write it from the config (`writeApi`, in `@sanoma-ai/workflows/describe`), one documented member per workflow, direct operation and collection.

| Call                                                                                          | What it does                                                                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `api.data.outbound.list({ order })`, `.get({ key })`, `.save({ record })`, `.delete({ key })` | A collection's operations, directly; a write is in the ledger, and `updatedBy` is the person                                |
| `api.stripe.customers.get({ id })`                                                            | A vendor's read, directly: an operation `describeConfig` marks `direct` (a vendor's write is refused: start a workflow)     |
| `await api.outboundNext({ company })`                                                         | Starts `outbound-next` (a workflow's name in camelCase) and answers its output once the run ends, or rejects with its error |
| `api.outboundNext.start(input)`                                                               | Starts it: `{ runId }`                                                                                                      |
| `.result(runId, waitMs?)`                                                                     | The run's output, waiting at most 20 s; `run_running` when it has not ended                                                 |
| `.latest()`, `.runs({ limit })`                                                               | The newest finished run's `{ runId, output, at }` (null when none has), and its latest runs                                 |
| `.approvals(runId)`, `.ledger(runId)`                                                         | What the run's page shows; a run of another workflow is `run_not_found`                                                     |

A visitor of a public site (`isVisitor`: signed in through a visitor login, or `anonymous`) calls the same way, where a policy `permit` lets it ([policies](https://www.npmjs.com/package/@sanoma-ai/workflows#policies)), with less to read: `.result` only of a run it started (another's is `run_not_found`), never `.latest`, `.runs`, `.approvals` or `.ledger` (`policy_denied`), and none of the runtime's own workflows (`invalid_input`). Later: read actions in the policy, so a rule can let a visitor read more.

An operation's call and a start send a new id each (`crypto.randomUUID()`, letters, digits, `_` and `-`; a start's is its run's id), so a request that is retried is made once; a person's next attempt is a new call, since a failed write's id is spent. Every call needs someone to say who is asking, as a change does ([Login](#login)): a loader's call runs in-process while the server renders the page, as the person whose request it renders. A refusal is an `ApiError`, whose `body` holds the stable `code`:

| `code`             | Status | When                                                                                                                                                                                                                 |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`    | 400    | Nobody said who is asking, the name is no operation or workflow, the operation is not direct, or the input does not match its schema (`issues`)                                                                      |
| `policy_denied`    | 403    | The policy denied the call, or a visitor asked for a workflow's runs                                                                                                                                                 |
| `approval_pending` | 409    | The policy holds the call for an approval: `runId` is the run of the built-in `call` workflow that makes it once approved, in the Inbox and at `/workflows/call/runs/<runId>`; `api.call.result(runId)` waits for it |
| `run_running`      | 409    | `.result` waited and the run has not ended (`runId`)                                                                                                                                                                 |
| `run_not_found`    | 404    | No such run of that workflow                                                                                                                                                                                         |

`sanoma/site` exports `ApiError` (`status`, and `body`, an `ErrorResponse`: `error`, `code`, and `issues`, `runId` and the rest as the code has them) and `errorBodyOf(err)`, the body when `err` is an `ApiError` and `undefined` otherwise, so a page branches on a code without a cast. A held write is `approval_pending`, with the `runId` of the run that makes it once approved:

```tsx
import { api, errorBodyOf } from "sanoma/site";

/** Marks the company won, or says where the change waits for its approval. */
async function markWon(company: string): Promise<string> {
  try {
    await api.data.outbound.save({ record: { company, stage: "won" } });
    return "Saved";
  } catch (err) {
    const body = errorBodyOf(err);
    if (body?.code === "approval_pending") return `Waiting for approval: /workflows/call/runs/${body.runId}`;
    throw err;
  }
}
```

`describeConfig` reads what each site calls from its source, never running it (`readSites`, in `@sanoma-ai/workflows/describe`): a workflow's page and a collection's list the sites' pages that call them under **Used by**, and a call to a workflow, collection or operation the config does not have, or to an operation a page may not call directly, fails `sanoma check`. A page links there only when this build serves it. Name what a site calls in its code (`<RunForm workflow="announce" />`, `api.announce.start(…)`, `api.data.outbound.list()`): a name held in a variable or built at run time is not read, so its page is not listed.

### Content

`content`, from `sanoma/site`, is the Markdown under the company repo's `content/`, as of the build: each folder directly under `content/` is a kind, and each `*.md` directly in it an entry, its slug the file's name. Both names are URL segments (`/^[a-z][a-z0-9-]*$/`); subfolders, `.mdx` and other files are left alone. A post, `content/posts/zapier-and-sanoma.md`, and the page that shows it:

```md
---
title: Zapier and Sanoma
description: How they differ.
publishedAt: 2026-10-01
---

What a visitor reads, in **Markdown** (GFM: tables, task lists, strikethrough).
```

```tsx
// sites/www/routes/blog.$slug.tsx
import { createFileRoute } from "@tanstack/react-router";
import { content, notFound } from "sanoma/site";
import { NotFound } from "../components/not-found.tsx";

export const Route = createFileRoute("/sites/www/blog/$slug")({
  loader: async ({ params }) => {
    const post = await content.posts.get(params.slug);
    if (!post) throw notFound();
    return post;
  },
  // Not found, it gives no title: the app's "Page not found" stays.
  head: ({ loaderData }) => ({ meta: loaderData ? [{ title: loaderData.data.title }] : [] }),
  component: Post,
  // Drawn here, inside the site's layout.
  notFoundComponent: NotFound,
});

function Post() {
  const post = Route.useLoaderData();
  return <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />;
}
```

| Call                            | What it gives                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content.posts.list()`          | Every file of `content/posts/`, sorted by slug, as `{ slug, data }`: `data` is the front matter (`{}` with none)                                                   |
| `content.posts.get(slug)`       | One file, `{ slug, data, body, html }`: `body` the Markdown after the front matter as written, `html` it rendered at build; `undefined` when there is no such file |
| `content.<kind>` with no folder | `list()` gives `[]` and `get()` `undefined`; once `.sanoma/content.ts` types `content`, it does not type-check                                                     |

- **Translations:** `content/posts/hello.fr.md` is `hello` in French, beside `hello.md`, the site's default language's. Its front matter is laid over the original's, so what it does not repeat (a date, an image, `draft`) is the original's: a draft's translation is a draft unless it says `draft: false`. A translation with front matter alone keeps the original's body. `list({ locale })` and `get(slug, { locale })` give each slug's file in that language, else its `<slug>.md` (an entry's `locale` says which: absent for `<slug>.md`); without `locale`, `<slug>.md` alone, as before translations. A language is a tag such as `fr` or `pt-BR` ([Languages](#languages)).

- **Not found:** a loader's `notFound()` is drawn by the nearest route, from the page up, with a `notFoundComponent`, in place of that route: give the page one, as above, and the site's layout one too (`sites/www/routes/route.tsx`), which draws a path no page has inside the layout. A page whose route has none draws in the layout's place when the layout has one, and, with neither, the app's not-found notice takes the page's place (on a public site's own host, [a plain page](#public-sites)). Its head runs with no `loaderData`.
- **Front matter** is YAML between a first line `---` and the next `---` line, read as YAML 1.2, so an unquoted date stays a string. A file whose front matter is not a mapping is left out, and `sanoma check` reports it at its line.
- **HTML** is rendered at build with `marked` (GFM), so no Markdown library ships to the browser. Raw HTML in a file passes through: content is reviewed as code is. The kit has no styles for it; give the `article` your own classes.
- **Drafts:** an entry whose front matter has `draft: true` is there while `sanoma` serves the sites from its dev server, and never in a build: not on a page, not in any file sent to the browser.
- **Loading:** the content is one chunk of the browser's bundle, loaded on the first call, and part of the server's render, so a loader's `await content.posts.list()` adds no request. A change under `content/` is a new build (the build's key covers it). On the dev server, a file saved under `content/` shows on the next render of an open page, with no restart.
- **Types:** `.sanoma/content.ts`, written with the sites' generated files (and again on the dev server when a file under `content/` changes), types `content` by augmenting `Register`, as `.sanoma/api.ts` types `api`: each kind's `data` is the union of its files' front matter, drafts included, a key in every file required and `?` otherwise; strings, numbers, booleans and `null` as themselves, a list as an array of its items' types, a mapping as an object merged the same way (so rows of a table in the front matter share one type). Values are never types: `status: draft` is a `string`. Until it is written, `content` is untyped.

`readContent(repo, { drafts })` and `contentTypes(kinds)`, from `@sanoma-ai/app/build`, are what the build and `sanoma check` read with: the kinds and the problems, each `{ file, line, column, message }`, and the text of `.sanoma/content.ts` (`CONTENT_TYPES`).

### Public sites

A public site (`defineSite({ public: true })`) is served at the root of its own host, and at `/sites/<name>` on the app's host as any site is, in the app's chrome, for the people who run it.

- **Its hosts.** `<name>.localhost` on the app's port (a browser sends `*.localhost` to this machine, and the loopback login lets it through), and the domain `startApp`'s `domains` gives it (`{ www: "sanoma.example" }`; the `sanoma` bin reads `SANOMA_DOMAINS`, which a host resource's `domains` sets). A domain naming a site that is missing or not public is warned about and served nowhere. `app.sites` gives each public site served, by name, at `http://<name>.localhost:<port>`; the Sites page links to the site's domain, else, on a page of this machine, to `<name>.localhost` (the server, which cannot know that address, says Public until the browser does).
- **One build, two routings.** On the site's host the router mounts the site at `/`: a page's `<Link to="/sites/www/blog">` is `/blog` there and `/sites/www/blog` on the app's host, and a path outside the site, `/workflows` among them, is the site's not-found page, a 404. The document there is bare: charset, viewport, a body with no margin, in a layer ahead of the site's stylesheet so any rule of the site's overrides it, the browser's light scheme (a site whose colours follow the visitor's light or dark, with `light-dark()`, says so in its stylesheet, as above: `[data-site="www"] { color-scheme: light dark; }`, not `:root`, which inside the app would override the app's own), and `<html data-site="<name>">`, which a site's stylesheet may scope its own host's rules to ([A site's own stylesheet](#a-sites-own-stylesheet)); no app stylesheet, theme, icon, chrome or config, which the app's host loads in chunks of their own. The site's layout sets its own icon and stylesheet in its `head`, and each page its title; the kit's look comes with that stylesheet ([The kit on a site](#the-kit-on-a-site)).
- **Not found and errors.** A page not found there, a path no page has or a loader's `notFound()` ([Content](#content)), answers 404, titled "Page not found" unless a route of the site gives a title: a title in the layout's `head` stays on every page, a page not found too, so give each page its own. Where the site draws no `notFoundComponent` or `errorComponent`, the page is a plain one of the app's (a heading and a line, no app styles), and an error's message stays out of it.
- **Its front door.** A request to the site's host never reaches the staff login, and its cookie and `x-sanoma-actor` header are ignored there. The site's login (`defineSite({ public: true, login: "<connector>" })`, a connector's login half) answers `/auth/<connector>/*` and verifies a visitor, who acts as `visitor:<connector>:<subject>` in the group `visitors`; anyone else, and everyone on a site with no login, acts as `anonymous`. Only `callFn` (a site's `api`) and `getActor` (`useActor()`, which says nobody for `anonymous`) answer there: any other server function is not there (a change's 404, a read's not-found), nor any other `/auth/` route (404), and a method but GET, HEAD and POST is a 405. Every request there carries `x-sanoma-client-ip` (`CLIENT_IP_HEADER`), set from the socket, a client's own copy overwritten. What a visitor may call is the policy's, by a `permit` ([above](#calling-operations-and-workflows)).
- **Its login.** `startApp` makes each public site's login half once it listens, before it resolves, with the company's database, a key of its own to sign its cookies with (derived from `SANOMA_SECRETS_KEY` for `login <connector>`, so a login like Better Auth needs no secret set), its stored secrets and the site's origins (`http://<name>.localhost:*`, and `https://<domain>` with a domain); a request that comes first waits for it, and `app.close()` closes it. A public site whose `site.ts` has a problem (its login may be one not read), or whose login fails to start, is served on no host, a 503, and the app's log says why; the app itself starts, so the connector's page, or `SANOMA_SECRETS_KEY` in the environment, can give what the login lacks.
- **Search engines.** The site's host answers `/robots.txt` and `/sitemap.xml` itself, ahead of its pages (a site cannot replace them). robots.txt lets every crawler read everything and names the sitemap; on any host but the site's domain (`<name>.localhost`) every response says `X-Robots-Tag: noindex`, which a crawler sees because robots.txt lets it read the page. The sitemap lists the site's pages at its origin: each route file's path with no parameter (`describeConfig`'s `SiteEntry.pages`, read from the route ids without running them), and, for a path with one parameter whose file reads one kind's entry by it, `content.<kind>.get(params.slug)` (or `slug`, destructured), a page per entry of that kind (`/blog/$slug` gives `/blog/<slug>` for each post): the content as of the build the app serves (its `published.json`), or as it is on the dev server, drafts left out on both. A page whose file reads its entry some other way (through a component's helper) is left out: when the file reads content by something else than its parameter, `sanoma check` warns, naming it. A page under `{-$locale}` on a site with [languages](#languages) is listed once per language (the default unprefixed), with `xhtml:link` alternates to itself in each language it is in and `x-default`: a content page is in a language when its entry has a translation into it or a `<slug>.md`, as `content.<kind>.get(slug, { locale })` reads it. The Sites page links each public site's sitemap beside its address.
- **Absolute URLs.** A canonical link, `og:url` and `og:image` must be absolute. `siteOrigin()`, from `sanoma/site`, is the origin a page's URLs take: on a public site's host, its domain when it has one (`https://<domain>`), else the host the request came to; on the app's host, the app's. `siteUrl(path)` is a page's URL from its path as the route tree spells it, at that origin, without `/sites/<name>` on the site's host and without a trailing slash but on `/`, as the router answers it and the sitemap lists it (an index route's `match.pathname`, `/sites/www/blog/`, gives `/blog`). Both work in a route's `head`, its loader and a component, on the server and in the browser (`<html data-origin>`):

```tsx
// sites/www/routes/blog.$slug.tsx
import og from "../assets/og.png";

export const Route = createFileRoute("/sites/www/blog/$slug")({
  loader: …,
  head: ({ match, loaderData }) => ({
    meta: [
      { title: loaderData?.data.title },
      { property: "og:url", content: siteUrl(match.pathname) }, // https://sanoma.example/blog/<slug>
      { property: "og:image", content: new URL(og, siteOrigin()).href },
    ],
    links: [{ rel: "canonical", href: siteUrl(match.pathname) }],
    // JSON-LD, as TanStack's head allows: a script of type application/ld+json.
    scripts: [{ type: "application/ld+json", children: JSON.stringify({ "@context": "https://schema.org", "@type": "Article" }) }],
  }),
});
```

- **Not on a public host:** the app's chrome and what it provides, so a site there brings its own toasts and has no `useDensity()` (it throws); `RunForm` and the will-ask preview, which read the config and link to the app's pages.
- **Later:** a `RunForm` on a public page; rate limits; `Cache-Control` headers on anonymous content pages, so a CDN in front can cache them (the cheap step toward prerendering), then prerendering where an edge cache serves the files (a content-only page's render reaches neither the database nor the worker already, and Start's prerender cannot render with the request context a page needs); the public host's own pending view; an anonymous id per session (every anonymous visitor is one principal now).

### Languages

A public site with no login can be in more than one language. Its `site.ts` names them, the first its default, and its pages go under `routes/{-$locale}/`, TanStack Router's optional path parameter: the default language at `/about`, each other at `/<locale>/about`, on the site's own host and under `/sites/<name>/` on the app's.

```ts
// sites/www/site.ts
export default defineSite({ title: "Website", public: true, locales: ["en", "fr"] });

// sites/www/messages.ts: the site's own strings, typed by the default's
import { defineMessages } from "sanoma/site";
import site from "./site.ts";

export const messages = defineMessages(site, {
  en: { blog: "Blog", read: (title: string) => `Read “${title}”` },
  fr: { blog: "Blog", read: (title: string) => `Lire « ${title} »` },
});
```

```tsx
// sites/www/routes/{-$locale}/blog.index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { content, Link, useMessages } from "sanoma/site";
import { messages } from "../../messages.ts";

export const Route = createFileRoute("/sites/www/{-$locale}/blog/")({
  loader: ({ params }) => content.posts.list({ locale: params.locale }),
  head: ({ params }) => ({ meta: [{ title: messages.get(params.locale).blog }] }),
  component: Blog,
});

function Blog() {
  const t = useMessages(messages);
  return Route.useLoaderData().map((post) => (
    <Link key={post.slug} to="/sites/www/{-$locale}/blog/$slug" params={{ slug: post.slug }}>
      {t.read(post.data.title)}
    </Link>
  ));
}
```

- **URLs.** `params.locale` is the URL's language, `undefined` in the default's. A `Link` keeps the page's language (the router carries `locale` over); `params={{ locale: "fr" }}` names another. A language the site lacks, and the default's own prefix (`/en/…`), are not found. A page outside `{-$locale}` has one URL, in the default language.
- **Strings.** `defineMessages(site, { <locale>: { … } })` takes every language of the site, each with exactly the default's keys and types, so a key or a language missing or extra fails `sanoma check`; a string with values in it is a function of them, its parameters typed in each language. `useMessages(messages)` gives the strings of the page on screen, `messages.get(params.locale)` those of a language in a loader or a `head`.
- **The page.** On the site's own host, `<html lang>` is the page's language (`useLocale()` gives it, for `Intl`'s formats, on either host; the app's host keeps `en`, its chrome's), and each page under `{-$locale}` in more than one language links to itself in each, `<link rel="alternate" hreflang>` with absolute URLs at `siteOrigin()` (the site's domain when it has one), and to its default as `x-default` when it is in that; the [sitemap](#public-sites) lists it once per language with the same alternates. A page is in every language, but a content page (one the sitemap lists per entry) only in those its entry is in, as its loader reads it: a post with no translation shows its original under each prefix, and a translation alone (`only.fr.md`, no `only.md`) is in French only.
- **A switcher** is the site's own component: `useLocales()` gives the page on screen in each language it is in, `{ locale, href, current }`, in the site's order, `href` its path on this host.

```tsx
export function Switcher() {
  return useLocales().map(({ locale, href, current }) => (
    <a key={locale} href={href} hrefLang={locale} aria-current={current ? "page" : undefined}>
      {locale}
    </a>
  ));
}
```

- **Content:** a post's translation is `<slug>.<locale>.md` ([Content](#content)).
- **In the app:** the Sites page lists a site's languages, its default first.
- **Later:** a visitor's language from `Accept-Language` or a cookie, redirected to; `sanoma check` naming a translation in a language no site has; translated path segments (`/fr/a-propos`); languages on a site with a login; the app's own screens in another language.

## Screens

The bar's sections, in groups: Inbox and Workflows; a tile per site ([Sites](#sites)); then Setup: Data (when the company has collections or sites), Resources, Connectors, Apps (its page is not built yet), Permissions (when it has policies, `policies/*.cedar`) and Go live. The app opens on Workflows, its home, which lists each workflow and how its last run went. Old links still work: `/` redirects to `/workflows`, `/runs` to its All runs view, `/runs/<id>` to the run's page under its workflow, and `/start?workflow=<name>` to that workflow's page with New run open, which says if the workflow is unknown (`/start` naming none, to `/workflows`).

- **Workflow** (`/workflows/<name>`): one workflow's page, which takes the window's full width (as the Inbox, Workflows and a collection's grid do; the other pages keep to a reading width). Its header names the workflow under **Workflows**, with its name, and **New run** at its end (none for a retired workflow), which opens New run over the Graph. Under it, pill tabs, each its own URL (`?view=`), each keeping the rest of the URL's search:
  - **Graph** (no `?view=`): the workflow's outline (see [Outline](#outline)), marked with the scenario `?scenario=` names, the inspector floating over its right (under it while the page is narrow, as with the chat column open on a laptop).
  - **Runs** (`?view=runs`), with how many it lists: the workflow's latest 50 runs, newest first, in a table: each named by its id's first 8 characters (the whole id in its tooltip), with its status (and, while it waits, the first approval it waits on), a sandbox run's scenario, who started it and when. The **Show runs** menu shows all of them, or only live, sandbox, waiting or failed runs, kept in the URL as `?runs=`: live and sandbox are picked from the latest 50 (so the tab says it found none, or lists those it found, among the latest 50), while waiting and failed are the latest 50 with that status, however old. A row opens its run (`?run=<id>`) in a card floating over the list's right (above it while narrow), the row marked: its status, a sandbox run's badge and, while it waits, on whom and for what; its error; who started it and when; its input; its ledger as a short trace; and **Open run**, its page. The runs refresh every 2 seconds while one of them can still change, else every 30 seconds, and at once when you start a run or decide an approval.
  - **Code** (`?view=code`): the workflow's source.
  - **Scenarios** (`?view=scenarios`), with how many, when the feature files have any for it: each scenario with its file and how many steps it has; the one opened (`?scenario=<name>`) floats with its text, **Sandbox run** (New run in Sandbox mode with it chosen) and **Show on the graph**.

  ![A workflow's Runs tab: its runs, one open in a card floating over the list](https://github.com/Sanoma-AI/sanoma/raw/main/.github/assets/runs.png)

  A workflow the config no longer has keeps its page while it has runs: its header names it, its Graph says it is gone and links to its Runs, and its runs draw a graph with only its name. With no runs either, its page is not found.

- **Run** (`/workflows/<name>/runs/<id>`): a run's page, under **Workflows** and its workflow's title, named **Run** and its id's first 8 characters, with its status, a sandbox run's badge, who started it and when, and **New run** (the workflow's). Under a notice for what it waits on (who, and for which approval, with **Show approval** to select it) or why it failed, the run's graph (see [Run graph](#run-graph)) with the inspector floating over it, then pill tabs, **Ledger** (open at first) and **Code**. A run of another workflow opens under its own. Its Ledger tab lists a sandbox run's **Checks**, drawn as the ledger's rows are: each `Then` of its scenario, which Cucumber runs against the ledger, each on its own, met, failed with why, or "not yet" while its answer can still change (until the run ends, unless it expects a call that has been made); when the run's scenario is no longer in the feature files, or they cannot be read, Checks says why instead. Then the ledger as a timeline: the start, each operation call with its effect, the policy's decision, duration, input and output, each approval asked, decided or ignored, and how it ended; a sandbox run's says how many calls it was seeded with.

  A workflow's Graph and Code, and a run's graph, Ledger and Code, are one view: clicking a node selects it, the graph rings it, Code marks its lines, and the inspector shows it, closing New run if it is open. Clicking a line in Code selects its node (the inspector then floats over the code, which leaves it room), and a ledger row's **Show in graph** button selects the node it is drawn as. The node selected stays as you switch between a workflow's Graph and Code; Runs and Scenarios drop it. The inspector shows, first match wins:
  - **New run**, while the URL has `?new` (its close button drops it): two links, **Live vendors** and **Sandbox**, each its own URL (`?scenario=<name>` is Sandbox with that scenario, none is Live), then the form. `/workflows/<name>/new`, the old New run URL, redirects here, keeping `?scenario=` and `?runs=`.
    - **Live vendors**: says which vendors the run calls for real and what the policy will do on a run you start (the will-ask line, as `RunForm` has it), then the form, built from the workflow's input schema: text, date and time (in your browser's time zone, shown as its ISO text until the page has loaded), numbers, yes/no, choices, lists with Add and Remove, and objects one level deep; anything else is entered as JSON. Optional fields left empty are left out, so the schema's defaults apply. The server checks the input with the workflow's schema and its complaints appear on the fields they name. **Start run** starts it and opens the run.
    - **Sandbox**: a menu of the workflow's [scenarios](https://www.npmjs.com/package/@sanoma-ai/workflows#scenarios-and-sandbox-runs) (**Sandbox** opens the first; with none, it is disabled and says so), and the form showing the chosen scenario's input with its controls disabled and no Add or Remove, since a sandbox run takes its input from its scenario. **Start sandbox run** starts it and opens the run, as you (a scenario's `Given ada is acting` is for `sanoma check` and tests, so the app never records a run as someone who did not start it): nothing leaves Sanoma, the fakes answering its calls. The scenario's lines of its feature file are behind **Scenario**, and the workflow's graph badges each operation a `Given` seeds ("seeded") or makes fail once ("fails", for `fails once`, `is rate limited once` and `loses its reply once`), and one a `Then` expects to be called ("expected"), not called ("not called"), denied by the policy ("must deny") or held by it ("must hold"), matching an outline's computed segment (`*`) as the run graph does. A scenario the feature files do not have says so. The scenarios are read again every 5 seconds while the page is open and when its window regains focus, so an edited feature file shows up without a restart; a file that cannot be read says why at the top of the workflow's page. The app decides nothing: the run's approvals wait for people, as a live run's do. Each sandbox run calls its own copies of the fakes, so several run at once, and one waiting on an approval holds up no other.
  - **The selected node**: its kind, its step's name (when its call gives one) and label; for an operation, its id, effect and vendor and what it does; and **Lines a–b** of the source, which opens Code. On a run's page, also the node's ledger records (a held call's with the policy's request and decision, an approval's with its decision), and the approval it waits on with **Approve** and **Reject**, so it is decided in place.
  - With nothing selected, **About** on the workflow's page: how it starts (by hand, or "Runs <cron> (<time zone>), next <time>", the next fire computed by the server), what it may call, its operations with their effects, its built-ins, its input and **Used by**: each site's page that calls it, under the site's title, through `RunForm` or `api`, linking to the page (a component's file, which is no one page, by its file); on a run's page, the run's facts (who started it, when and its id) and its approvals, each with the operations it lets through (badged by effect), and **Approve** and **Reject** with an optional note while the run can still read a decision. When the run has not read a decision within 5 seconds (no worker is running, say), it stays queued and the run reads it when it next runs: the dialog closes and the page shows the decision as queued, with Approve and Reject disabled for that approval, until the run's status changes. Every card but New run has a close button: closing hides the inspector (and drops the selection) until a node is clicked, and an **About this workflow** (on a run's page **Show the run**) button at the card's corner brings the overview back.

- **Inbox** (`/inbox`): the approvals, with how many are pending beside its title. Pill tabs pick the list, each its own URL (`?show=`): **For you**, the pending approvals you may decide (the default once the page knows who you are, and counted from then), **Everyone**, every pending approval (the default until then), both newest first and with how many they list, each with **Decided today** under it, the approvals decided since midnight (your browser's) in the latest 50 runs; and **Decided** (`?show=decided`), the approvals decided in the latest 50 runs, latest first. The list is one card: each row has the approval's title, how long ago it was asked (a decided one: its decision, and how long ago it was made), its workflow and who started the run, and opens it (`?approval=<runId>/<approvalId>`), marked while it is open. The open one, by default the first for you, else the first, floats over the list's right (above the list while the card is narrow, as with the chat column open on a laptop): its title and status, a sentence saying whose run of which workflow wants to do what (the operations it lets through, such as "publish a post in Ghost"), its details, and at its foot the same controls as on its run's page. Once you decide, it leaves the list and the next one opens; with nothing for you, a link shows those waiting on others. Refreshes every 5 seconds.
- **Changes** (`/changes`, in the bar after Inbox when the repository has a remote): the changes sent for review from a chat's draft card (**Send for review**, offered once the draft has a commit and its checks pass), each draft's latest, newest first, **Open** and **Done** as pill tabs (`?show=`), each row its title, where it is, how many files it edits, its pull request and when it last moved. A change's page (`/changes/<id>`) shows where it is ("Waiting for admin", Published, Closed), its branch at the head it last planned, its pull request and its run; what changed, by kind (policies, people, resources, workflows, sites, each app's); who may do what, the Permissions grid of `main` against the branch's, each changed cell with its before and after; and, floating, Publish: the policy's answer, the checks, and once merged the merge commit and the deploy, with **Publish** and **Reject** while it waits. Publish is also the change's approval in the Inbox, with the change linked. How a change runs is the [runtime's](../workflows/README.md#changes).
- **Workflows** (`/workflows`): the home, the window's full width. Its header says how many workflows the app has and the config's version (cut short, the whole of it in its tooltip), with **New workflow**, which opens the chat on a new chat with "Make a workflow that " in its composer for you to finish (not in a demo, which has no chat); a notice says so when the repo's policies do not hold, as they then refuse every call and start. Pill tabs, each its own URL with how many it holds, pick the rows (`?filter=`): **All**, **Waiting on you** (runs waiting on an approval you may decide), **Failed last run** and **Built-in**; the last tab is **All runs**. Under them, one card: a box that finds a workflow by its title or name as you type, over a table of every workflow in the config, those whose runs wait on an approval you may decide first (badged with how many), then by their last run: its title (linking to its page), its name, built-in for the built-in `drift` (which starts like any other, with no input), how it starts (by hand, or the cron it runs on and its time zone), the vendors its operations call, in order of title, its last run's status and when, and how many approvals its runs wait on, on anyone. What it may call, its built-ins, its input and its outline are on its page. **All runs** (`?view=runs`) lists the latest 50 runs of every workflow, newest first: each with its workflow (linking to the run's page under its workflow, the run's id as its tooltip), a sandbox run's badge, its status, who started it and when, how many approvals it waits on, and a failed run's error. Its **Status** menu shows only the runs with that status, the latest 50 however old, kept in the URL as `?status=`; `?workflow=<name>` shows only that workflow's, named beside the menu with a button that removes it. The table refreshes as a workflow's Runs tab does. **New workflow** opens a dialog saying how to add one to the repo (a file under `workflows/`, listed in `sanoma.config.ts`, which the app shows once it restarts); drafting one from a description is coming.
- **Resources**: each resource the data files declare (its name, type and vendor, the declaration it comes from, which opens in its file below the table, marked, and the vendor object the lockfile binds it to, its id cut short), with the latest drift check's verdict: clean, drifted (with each field that differs, as declared and as the vendor holds it, shown under its row), gone, absent (not bound yet, and whether its identity found an object), error (and why), or not checked. Bindings in the lockfile that no data file declares are listed under the table, each with its key, type and id: apply asks whether to forget each or delete its object. **Apply** starts the built-in `apply` workflow on every declaration, and goes to its run; the config registers it beside drift. Apply holds its plan for a person: wherever an approval's details carry one, the Inbox and the run show it as the change view: problems in the data files, each change to the lockfile apply did not make in plain words ("points store at a different project: abcdefgh… → wxyzabcd…"), then the steps by action: creates with their planned fields (what the vendor fills in is "known after apply"), updates and replaces with the fields that differ (and, for a replace, the fields that cannot change in place), binds (found by identity, or given), gone objects and orphaned bindings with the question each asks, and the unchanged, folded. Each drifted field has **Adopt**, which writes the value the vendor holds, as that check's report has it, into the data file (`setFields`: only that declaration changes), commits it when `startApp` is given a `source` (the company's repository; without one it only writes the file), and starts a drift check, which reads the file as it now is. **Run drift** starts the built-in `drift` workflow, which reads the data files as they are then; the page reads the drift runs as a workflow's Runs tab does, every 2 seconds, links to the latest run, and shows the report of the latest that finished. Problems in the data files show above the table, each at its file, line and column, since their resources are left out: those the app found when it started, and any the last check found. The declared list is the one the app read when it started (`describeConfig`), so a data file changed since shows in the last check's rows and problems, but its declaration opens only once the app is restarted (to do: read the files again when they change).
- **Data** (`/data`): the config's collections, with how many beside the title, in a table: each one's title and name, how many fields it has, the field it is found by and where `resources/data.ts` declares it, linking to its grid. **A collection** (`/data/<name>`) is its records in a grid, the page's full width: a column per field, in the collection's order, then when each record was saved and by whom. A field's heading sorts by it, ascending, then descending, then by key again (`?order=`, `-` for descending); above the grid, **<key> starts with** keeps the records whose key starts with what you type (`?key=`), each enum field has a menu of its values (`?where=`), and **Show at most** sets how many it reads, 100 at first, up to 1000 (`?limit=`); it says so when there may be more. A record saved before its fields changed, which they now refuse, is badged **needs fixing**, what they refuse in its tooltip. **Add record**, or a record's row, opens the record form beside the grid (`?new`, `?record=<key>`), drawn from the collection's fields as a start form is from a workflow's input: text, a number, yes/no, a choice for an enum, a date input for a date (one a workflow saved with a time shows as a date and time), and a person as their id, a new record's people starting as you; an edit's key cannot change. **Save** saves it, and **Delete**, once confirmed, deletes it. Every read and change is the collection's operation (`data.<name>.list`, `.save`, `.delete`) called through `api` as you, so the policy decides each and a save or a delete is in the ledger: a denial shows on the form; a call the policy holds for an approval says **Held for approval**, linking to its run of the built-in `call` workflow (`/workflows/call/runs/<runId>`), which makes it once approved in the Inbox; what the fields refuse shows under them. The header names the collection, its operations' prefix and where `resources/data.ts` declares it (opening it on the Resources page), and **Used by** lists the workflows whose `uses` name one of its operations, then the sites' pages that read or write it, as a workflow's page lists those that call it. The Resources page lists the collections too, each linking here. History, import and export are not there yet.

  ![A collection's grid: the outbound leads sorted by stage, a record open in the form beside it](https://github.com/Sanoma-AI/sanoma/raw/main/.github/assets/data.png)

- **Permissions** (`/permissions`): what the policy answers someone in no group, in each group (the declared ones, `agents` and `visitors`) and `anonymous` (Anonymous, a public page with nobody signed in), across, for the start of each workflow, with each operation it uses under it, and each operation a person may call directly down, with the policy beside the page's title: Cedar, its files, its version and how many groups, workflows and operations the grid has, and a notice when the policies do not hold, as they then refuse every call. Each cell is the policy's answer for someone in that group alone (an agent acting for someone, so a hold for `on-behalf-of` asks "whom it acts for"; a visitor, denied a start and a direct call no `permit` names, and allowed an operation in a run), the input unknown: allow (muted), hold (with whom it asks), deny, or depends (the input decides); a hold, a deny or a depends opens the rule behind it in a sheet (its id, its file, its `@title` or `@reason`, and for a hold whom it asks), with Show the rule. Under the grid, each policy file is shown read-only, titled by its path, as a workflow's Code tab shows its source (plain: the app has no Cedar grammar); Show the rule marks that rule's lines there. Nothing here is edited: the rules are `policies/*.cedar`, and the people and groups the Resources page lists. With a remote, a line under the grid says what the repository's host enforces on `main`: a pull request and the `sanoma` check, or what it lacks and why, in the host's words.
- **Apps** (`/apps`): the company's apps, with how many beside the title, in three lists. **Yours**: the apps of its own (no source), each with its folder and what it holds (workflows, collections, sites). **Taken**: those merged from a source repository (`app.ts`'s `source`), each with its source, linked, how many commits it is behind that source (fetched by the page once it shows, or why it cannot tell) and **Update**. **Available**: the apps on GitHub not taken yet (the repositories with the topic `sanoma-app`, through the built-in `sanoma.apps.list`, called as you once the page knows who you are, so the policy decides it and GitHub never holds up the rest of the page), Sanoma's own first, each with its tier (Official, Vendor verified or Community, from Sanoma's claims, `sanoma/claims`), whether Sanoma reviewed it, its description and license, its README, a solution's demo (**Try it**) and **Add**. **New app**, **Add** and **Update** open the chat with a prompt for the agent ("Make an app that ", "Take the app from <url> into this company with take_app, …", "Update the app in apps/<name>/ from its source with update_app, …"), which drafts the change on a branch of its own; when GitHub cannot be searched, a notice says why and the repo's apps show all the same.
- **Connectors**: each vendor the config's operations are from, by title, with its logo and id (never the built-in `sanoma` and `data`, which call nothing outside: a workflow's vendors and New run's "Calls … for real" leave them out too), how many operations it has and how many workflows use it, and, when its drivers declare environment variables, whether it is configured or how many variables it needs, each linking to its page, under Installed, with its tier (Official for an `@sanoma-ai/` package, else Community). Under Available, the connector packages on npm that the config does not install, found by the `sanoma-connector` keyword and shown by the `sanoma` field of each one's latest version (title, and logo files the server reads from jsDelivr and checks as an installed connector's are, shown as images only), with its tier, description and version; nothing is stored, and npm is read at most every 10 minutes. Choosing one opens the steps to add it (`?add=<package>`): `pnpm add`, the import in `sanoma.config.ts`, then its credentials; there is no install button. When npm cannot be reached, a notice says only the installed connectors show.
- **Connector** (`/connectors/<vendor>`): links to its connector's npm package and source (from `defineConnector`'s `package` and `homepage`, when it gives them), its resource types, and each operation with its effect, whether it is safe to retry, its description, its contract (input and output as JSON Schema), its scenario `phrases`, the scenarios with a step about it (each marked as seeding it, making it fail, expecting it or saying it must not be called, and linking to its workflow's New run in Sandbox mode with it chosen), and the workflows that may call it; a feature file that cannot be read says why above the operations, as on a workflow's page. A vendor with workflow operations whose connector attaches no fake (its `VendorEntry`'s `fake`) says "Its connector attaches no fake" once, above its operations; one with only a resource type's `read` and `import` needs none, since those read real state and a sandbox run never calls them.
- **Go live** (`/setup/connect`): connects the company's GitHub and the vendors of its database, host and wakeup, the first step of going live. **Create GitHub App** (with an organization's login, or empty for your personal account) goes to `/setup/github/manifest`, a page that posts the App's manifest to GitHub (administration, contents, pull requests and commit statuses: write; push and pull request events, its webhook at the app's `/webhooks/github`, on unless the app is on this machine; its OAuth callback the login's `/auth/github/callback`), with its state and who asked in a signed, httpOnly cookie (nobody signed in is sent back here, told to say who they are first). You name and create the App on GitHub's page; GitHub sends you back to `/setup/github/callback`, which checks the state, exchanges the code (`POST /app-manifests/{code}/conversions`) and stores the App's id, slug, client id and secret, webhook secret and private key as encrypted credentials set by who asked (`SANOMA_GITHUB_APP_ID`, `SANOMA_GITHUB_APP_SLUG`, `SANOMA_GITHUB_CLIENT_ID`, `SANOMA_GITHUB_CLIENT_SECRET`, `SANOMA_GITHUB_WEBHOOK_SECRET`, `SANOMA_GITHUB_APP_PEM`), then comes back here saying how it went (sign-in uses the new client once the app restarts on a host beyond this machine). The page then shows the App's slug with **Install**. An installation token can create a repository only in an organization that granted the App administration access, so for a personal account the page also takes a token of your own, `GITHUB_TOKEN`; and, when the config declares a type of the vendor, Supabase's access token (`SUPABASE_ACCESS_TOKEN`), Neon's organization API key (`NEON_API_KEY`) and, optionally, Cloudflare's API token and account id (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). They are set as on a connector's page (the same rows, so a connector that declares them shows them too); the page never shows a value. Going live chooses by contract among the config's types whose vendor is connected (for the database and the host, a vendor this page does not connect counts as connected; the page names the vendors still to connect, and refuses a database or host other than the one it showed): the database (Neon's project first, else the first type that meets the `Database` contract, with its regions, which it holds the choice to, and size), the host (Cloudflare's container once its token and account are stored, else Docker's, else the first host; any host but Docker runs `ghcr.io/sanoma-ai/runtime:<the sanoma version the company installs>`, which Cloudflare copies into its account's registry at apply) and the wakeup (a connected one that wakes that host, the host's own vendor's first: Cloudflare's alarm before `sanoma.wakeup`). The repository is private, so going live also makes a new deploy key, its private half stored as the host's `SANOMA_SOURCE_KEY` (among its `secrets`, never shown) and its public half declared after the repository as a read-only `github.repository_deploy_key`, which the apply that makes the repository adds to it, and the host's apply waits for (a file written before deploy keys, or by **Connect an existing repository**, declares none, and its host clones as before); a GitHub connector with no such type is named among what is missing before anything is written. Every start of the host clones with it ([Cloning a private repository](../sanoma/README.md#cloning-a-private-repository)). When the config declares a host type, the page also offers **Connect a wakeup service**, for scale to zero: the [wakeup service](../sanoma/README.md#the-wakeup-service)'s URL, `SANOMA_WAKEUP_URL` (Sanoma's, or your own `sanoma wakeup`), and an account's token there, `SANOMA_WAKEUP_ACCOUNT_TOKEN`, both optional. Storing the account's token also mints the instance's own, `SANOMA_WAKEUP_TOKEN`, unless one is stored, and never shows it. With both stored and no wakeup of the host's own vendor connected, going live writes the runtime's own wakeup (`export const wakeup = sanoma.wakeup({ host })`, imported from `sanoma/resources`) into `resources/sanoma/infra.ts` after the host, mints `SANOMA_WAKEUP_TOKEN` when none is stored, and gives the host it (and `SANOMA_WAKEUP_URL`, for `sanoma.wakeup`) among its `secrets`, so the one apply of the host and the wakeup gives the worker on the host what it registers with; removing the line and answering its orphaned binding **delete** on Resources deletes the instance.
- **Connect an existing repository or database** (`/setup/existing`, linked from the connect page): takes a GitHub repository (`owner/name`, of the owner the GitHub connector reads) and/or a Supabase project's ref, reads each through its type's import (in the app's process, before any declaration names it; apply's own import, when it binds, is in the ledger), and writes `resources/sanoma/infra.ts` from what was read: the repository's name, description and visibility; the project's name, organization and region, with its database password declared as a generated secret, which Supabase never reads back, so the next apply that changes the project sets a new one. In a repository without a remote, the file is committed where the checkout is; with one, on a new branch, `setup/connect-existing`, checked out, and the page shows the diff: merging it is the approval. Then it starts apply with `bind` and `only` for those declarations, which binds them in the lockfile (committed on the same branch) and creates nothing. Refused when `infra.ts` or the branch is there already.

For a vendor whose drivers declare the environment variables they read (see [Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)), the connector's page lists them under **Credentials**, above its operations: each variable's name, its description, whether it is optional, and its status: set, missing, or invalid with the reason. A variable the app's environment sets says "set in the environment" and has no controls, since the environment wins. Any other has **Set** (**Replace** once set), which opens a small form with the variable's description and a password field: **Save** stores the value in the runtime's database as you, and running workers load it without a restart; the schema's reason for refusing a value shows under the field. A stored value reads "set by <who> · <when>" and has **Clear**, which deletes it. The page never shows a value, and the form forgets what you typed once it closes. The statuses are read when the page asks, from the app's environment and the stored values, so run the app on the worker's environment.

The screens share one shell: down the left, the bar, and beside it the chat column, then the page. The bar has **Chat** first, then the sections and the sites' tiles in their groups, each an icon in a tile with its label under it, the current one filled (Inbox badged with how many approvals are pending), and at its foot the menu under your initials. **Chat** folds the chat column away and opens it again, and the app opens it as you left it on your next visit (it keeps that in a cookie, `sanoma_chat`, so the server renders the page with it open or folded from the first paint); until then it is open where it sits beside the page and folded where it would lie over it. The column is your chat with the agent: your latest chat (the others, and **New chat**, at its top), your messages at the right, its replies under them with the steps it took as a checked list, and at its foot the composer, carrying the page you are on. The agent edits only a draft of its own, a branch `draft/<chat>` it opens at its first edit and commits to as it goes, and runs the checks there; its reply ends with the draft's card (the branch, what changes, the checks) and you apply it by merging the branch (the live instance runs the old code until it restarts). It takes an app into the draft with `take_app`, a git merge of the source repository (an `https` URL) whose `apps/<name>/` lands as the company's, every other file staying the company's but `package.json`, which gets the source's beside its own, and updates one with `update_app`, a merge of the new commits of the source its `app.ts` names, as far as they touch `apps/<name>/` and `package.json`; a file git cannot merge is committed with its conflict markers, which the agent resolves before the checks pass ([Apps](../workflows/README.md#apps)). `takeAppPrompt` and `updateAppPrompt` (`src/lib/apps.ts`) are what the Apps page's Add and Update put in the chat. A lookup the policy holds shows its approval's card in the reply (or who it waits for, with the Inbox's link), and the turn goes on once it is decided. The chat is kept in the company's database: a restart loses the turn under way, not the chat or the draft, and **Continue** picks up. The model is the first connector with a model half, its default; without its key, the reply says so with a link to its connector page. A new chat's composer picks its engine, which the chat keeps and names at its top: **Sanoma** (our own loop, the default), or an existing coding agent on the company's Anthropic key, **Pi** or **Claude Code**, driven through the AI SDK's `HarnessAgent` in the chat's draft. A coding agent reads the repository's `AGENTS.md` itself; its file edits are allowed inside the draft and refused outside it or under `.git` or `node_modules`, its shell commands are refused, each with the reason shown as a refused step (so taking or updating an app is the Sanoma engine's) (Claude Code reads files itself, as this machine's user: only its edits and commands ask); at the end of its turn its edits are committed on the draft and checked. Claude Code's first turn on a machine installs it under `.sanoma/agent-home/harness`, this engine's own home (about 760 MB, 40 s), which needs pnpm 11 and bash on the `PATH`; its bridge listens on all interfaces, guarded by a token, so keep that port behind a firewall. Under **Your own plan**, the composer offers a person's own coding agent, on their own subscription, driven over the Agent Client Protocol by the app's own client in the chat's draft: **Copilot**, **OpenCode** (its free models need no sign-in), **Pi**, **Claude Code** and **Codex**. A person's own agent spends that person's plan under their vendor's terms, which Sanoma neither checks nor changes. The agent runs as a child of the app with an environment of its own: its `HOME` is the person's (`.sanoma/agent-home/people/<id>`, kept across restarts), so a sign-in is kept for that person and never the company's (every person's agent runs as this machine's user, so on an instance several people share, what an agent runs itself can reach another person's sign-in), and none of the app's or this machine's credentials reach it (no token variables; `gh`, `security` and the browser openers refuse on its `PATH`). Its first turn on a machine installs it under `.sanoma/agent-home/acp/<agent>` with the pnpm on the `PATH` (the desktop shell ships its own), in 10 to 45 s and 150 to 340 MB each. So `.sanoma/agent-home` holds three directories, each one engine's: `harness` (Pi and Claude Code on the company's key, whose session's files are the draft's and this directory's only; Claude Code's own reads and the commands a bridge runs are this machine's user's), `acp/<agent>` (the installs of people's own agents) and `people/<id>` (each person's own agent's `HOME`, given only to that person's agent). When the vendor asks the person to sign in, the reply is a sign-in card: the vendor's link and code (Copilot's and Codex's device flows), with a field for a code the vendor asks to have pasted back (Claude Code's), or, for Pi, whose sign-in needs a real terminal, the command to run once on this computer; the app opens no link and enters no code, the card keeps neither once it ends, and after signing in the person sends the message again. The agent's requests to read or edit a file are allowed inside the draft and refused outside it or under `.git` or `node_modules`, as are its requests to run a command and anything else it asks for, each with the reason as a refused step (it is never given an always-allow); the files it reads and writes through the app are the draft's only. What it runs in the app's terminal, and what its own tools do without asking (OpenCode edits and runs commands inside the draft without asking), are its own: the draft's commit and its checks, at the end of the turn, are the gate. From 1024 px wide the column sits beside the page; narrower, it lies over the page; on a phone (under 768 px) there is none, and the bar is a sheet over the page, opened from the menu button atop it, that closes as you follow a link or tap beside it. Each page starts with its title, with what it counts beside it and the pages above it as links (Workflows, then the workflow's title, on a run's page), its actions at the end of the row; then, on a page with views, pill tabs, each a URL; then one card. What you open from a list, an approval, a run, a scenario or a graph's node, floats over the card's right in a card of its own, and sits above the list (under a graph) while the page's card is too narrow. **Density**, in the menu at the bar's foot under the theme, switches the page to **Compact**, a tighter density for people who live in the app: the page a quarter tighter in every padding, gap and control (its icons too; the text keeps its size), half the gap between a page's regions, a lower graph card and source (a floating card keeps its width). The browser remembers the density in a cookie (`sanoma_density`), so the server renders the page in it from the first paint. The menu at the bar's foot, under your initials, has who you are (and Change name, under the default resolver), the theme (light, dark or the system's, which the browser remembers) and the density. The screens are built with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`, from `components.json`) on Tailwind CSS, in the theme `src/style.css` holds: Sanoma's palette in light and dark, IBM Plex Sans and Mono (Fraunces for display), and 28 px controls.

### Run graph

A run's page draws the run as a graph, left to right: the start, each operation call (its effect, the policy's decision, its duration or error), each sleep, each approval the workflow asked for, and how the run ended, or a dashed end while it has not. An approval the policy asked for sits on the call it holds. The calls of one `ctx.all` branch out side by side and join again after it. Each node's colour says how it went: done, failed or denied, waiting on a person or a sleep, or running. The graph is read from the ledger alone, so it shows what happened, not what the workflow may still do, and it redraws as the page polls. Clicking a node shows it in the inspector, scrolls to its record while the Ledger tab is open, and marks the call in the workflow's source under **Code**: the one the worker placed the call at, which the record names (`node`), when the source still has that call there, so a loop's every pass marks its one call, and a call from a ledger written before calls were placed, or whose file has changed so that another call or none is where it was, marks nothing rather than a guess. Clicking a call in the source selects its node: of a loop's passes, the latest. A sleep is labelled with the time it ends, in UTC, as the ledger shows times, so the server and every browser draw the same text. It is drawn with [React Flow](https://reactflow.dev) in the browser only; the server renders a placeholder of the same size, the graph's code loads, once, only on the pages that draw a graph (a workflow's and a run's), starting as the page's data loads, and each graph is drawn when it first scrolls near the screen. A graph pans sideways with the scroll wheel or a drag; its zoom control (React Flow's zoom slider, in the bottom left corner) zooms out and in, shows the zoom (a click sets it back to 100%), and fits the whole graph in view.

A `ctx.all` draws as one lane per member, top to bottom in member order, between the step before it and the step after: in a run that posts to three vendors at once, sleeps, then reads two results at once, the graph shows three lanes, the sleep, then two lanes, each lane coloured as its call went (a call the policy holds waits in its own lane). While a `ctx.all` is the last thing the run has done and the run goes on, each member that has recorded nothing yet has a dashed "not started" lane. Members that never ran, after one failed, or once the run has moved past the group or ended, have no lane. An operation whose call has a [step name](../workflows/README.md#step-names) other than its id says the name, with the id on the line below; a sleep with a name says it the same way, above its clock and the time it ends. A long loop label is cut short in its box; hovering shows it whole.

### Outline

Each workflow card on the Workflows page, and a workflow's page, draw the workflow's shape before it runs, from the `outline` that `describeConfig` (`@sanoma-ai/workflows/describe`) reads once per workflow when `startApp` starts; the source under a workflow page's Code tab is the workflow's file as it is when the page asks for it. It is the run graph's drawing without colours: the operations (with their effects), approvals and sleeps the body of `run` calls, a `ctx.all` as lanes, a loop or a `ctx.all` over a list as a box labelled from its code ("for each of subscribers", "repeat while more") (the line into the box goes on inside it to its first nodes, and its last nodes join the line out), an operation or sleep by the name its call gives, and an `if` or `switch` as a diamond that splits into one lane per case, plus a lane marked "otherwise" when the run can go by without any of them (an `if` without `else`, say). It is a reading of the source, labelled so: "Read from the body of run; the functions it calls are not shown, even those defined in it". When the source cannot be read the card says why instead.

## Login

`GET /healthz` answers `ok` before any login, whatever host it is addressed to: a host's probe that the app is up, and nothing more.

`startApp(config, { ingress })` adds machine routes (`IngressRoute`), answered by exact path right after `/healthz`, ahead of the public sites and the login, at any host: each checks its own token. A route with `prefix: true` also answers every path under its own (`/wakeup` answers `/wakeup/instances/…`, the [wakeup service](../sanoma/README.md#the-wakeup-service)) and matches what follows itself; a route at the exact path comes first, then the longest prefix.

Beside them, but in a demo, the app answers a git host's webhooks at `POST /webhooks/<vendor>` for each connector whose remote half reads them (`webhook`; [remote halves](../workflows/README.md#usage)), GitHub's at `/webhooks/github`: the half verifies the delivery's signature over its raw body with the webhook secret (`SANOMA_GITHUB_WEBHOOK_SECRET`, the environment's, else the stored one), and each event it carries goes to `SanomaClient.remoteEvent` as the runtime's agent `host-check`, with the app's `source`: a push to `main` applies the declared hosts, a push to a draft's branch plans its change again, a closed pull request ends it. It answers 204 once they are done, 401 for a missing or wrong signature, 404 when no half of that vendor reads webhooks or its secret is not stored. Only an instance GitHub can reach hears them: a laptop has no public URL, so there a change's merge reads its pull request on GitHub itself (one merged or closed there ends the change once Publish is pressed), and a push to `main` made outside Sanoma is not deployed. An App made by the manifest before this version has its webhook off and lacks commit statuses: turn on **Active** under the App's settings' Webhook (GitHub's `PATCH /app/hook/config` sets only its URL, content type, secret and SSL check, not whether it is active), set its secret there if it has none and store it as `SANOMA_GITHUB_WEBHOOK_SECRET`, add **Commit statuses: Read and write** under its permissions, and accept the new permission on each installation. `onWrite` is called right before each change the app makes that a worker must run, a run's start or an approval's decision, never a read (`sanoma serve` starts its stopped worker again with it).

`startApp` takes a `login` provider, which says who may use the app and who is making each change. Without one, the app has no login and listens on this machine only; with one, it may listen on any host. A public site's own host has its front door instead, its visitor login or none ([Public sites](#public-sites)): the login here is for the people who run the company.

### No login, on this machine

The default, `loopbackLogin()`. The page asks "Who are you?" once (a choice of the people the data files declare, by name and id, or while they declare no one a name to type), keeps the answer in the browser, and sends it, URI-encoded, in the `x-sanoma-actor` header with every server function call; a change that names nobody is refused. It keeps the name in the `sanoma_actor` cookie too (`SameSite=Strict`), which the login reads when a request has no header, so the server's render of a page whose loader calls `api` knows who is asking; a page another site sends the browser to renders as nobody. Anyone who can reach the app can start runs and decide approvals as any name they type; the approver check only compares names. So `startApp` refuses any `host` but this machine's (127.0.0.1, the default, `localhost` or `::1`) without another login. While it listens on this machine only, it refuses every request (page, server function or static file) whose `Host` names anything but this machine (`localhost`, a loopback address, or a `*.localhost` name), so another site cannot reach it through DNS rebinding.

Reads are open. Anyone who can reach the app sees every run, its ledger (each operation's input and output included) and its approvals, through the page and the server functions it reads them with; nothing asks who they are. On this machine, the Host check above is the only protection. A failure the app does not expect shows only "Something went wrong": its message can name internal details, such as a database host, so the app logs it instead.

### GitHub

`githubLogin` signs people in with GitHub, and the app admits a declared person: the one whose `email` is the public email GitHub has verified for them, else whose `github` is their login (each ignoring case); anyone else gets a 403 saying they are not in `resources/people.ts`, and while the people file declares no person, nobody signs in. No access to the company's repository is needed. Every request without a session gets the sign-in page (a server function call, a 401), so reads are signed in too.

```ts
import { githubLogin, startApp } from "@sanoma-ai/app";

await startApp(config, {
  host: "0.0.0.0",
  login: githubLogin({ clientId, clientSecret }),
});
```

The OAuth client is the company's GitHub App's, with `<the app's URL>/auth/github/callback` as its callback URL. The session is a signed, httpOnly cookie that lasts 12 hours, keyed from `SANOMA_SECRETS_KEY`, which must be set (`githubLogin` throws, naming it, when it is not); who may sign in is read on every request, so removing someone from the people file takes effect at once. The person acts as declared, by their id and the groups that list them, so approvals and the ledger name them. The menu at the bar's foot shows the login, your groups and Sign out. The `sanoma` bin builds this from `SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET`, and listens on `SANOMA_APP_HOST`; on a host beyond this machine, or with one of them set, one the environment leaves unset is read from the stored credentials, where creating the App on **Go live** put them.

### Demo

`startApp(config, { demo: true })` runs the repo as a demo, which [`sanoma demo`](../sanoma/README.md#commands) starts (`SANOMA_DEMO=1` on a host): every vendor on its fake, one per vendor for the instance (`resolveConfig(config, { fakes: "instance" })`), and the world and the moments of its scenarios seeded as it starts and again every hour, `sanoma.demo.reset`, a timer in the app's process (not a schedule of the worker's: the Runs do not list it, and a restart seeds at once and starts the hour again) (`reseed` from `@sanoma-ai/workflows/scenarios`, [Demos](../workflows/README.md#demos): the unfinished runs cancelled, `sanoma_data` emptied, the worlds applied and each moment started, waiting in the Inbox for its person). The worker that runs the demo's runs must call the same fakes, so it starts in the same process on the same resolution, given to both as `resolved` (`sanoma serve` does this). Its login is the demo login: anyone who reaches it is one of the people `resources/people.ts` declares, whoever a link names with `?as=<id>` (kept in the `sanoma_demo_as` cookie, the page loading again without it; an id nobody has is a 404 page), else the first person declared, admitted as declared like any login's. A moment's URL is so `/<path>?as=<person>`. The demo login refuses an app not started with `demo: true`, and a demo listens on any host: every vendor is a fake and nothing lasts past the hour. A banner atop every page says who you are, with a switcher of the people, that nothing is saved, and "Start with these apps", linking to the config's `demo.start` when it gives one (`defineConfig({ …, demo: { start: "https://…" } })`). There is no chat agent in a demo and no Go live: no Chat or Go live in the bar, `/setup` and its routes and `POST /api/chat` and `/api/sign-in` are a 404, and what would outlast the reseed (storing a credential or a token, Adopt, going live) is refused with a 403.

### Your own

A `LoginProvider` is `{ name, check(listenHost, started), resolveActor, handle?, signOut? }`. `check` throws for a host the app may not listen on, or for how the app was started (`started.demo`, which only the demo login needs). `resolveActor` turns a request into who the login vouches for (`LoginIdentity`: `{ id?, email?, github? }`), or `undefined` to refuse a change; the app admits only the declared person it matches (`admitting`: by email, then GitHub login, then id), who acts as declared, so a provider's own roles or group claims never reach the policy. `handle`, when there is one, sees every request first: it answers its own routes under `/auth/<name>/` and any request it will not let through, and returns `undefined` for the rest. `signOut` is the path the page POSTs to to sign out, which `handle` serves; with it, the menu shows Sign out.

With a login provider, the page never asks for a name: it shows who the login says you are. An approval addressed to a group (`{ group: "finance" }`) can be decided only by someone the people file lists in it. The app calls `resolveActor` only for a request that needs to know who is asking, once per request. One that throws fails the change with a 500, logged as "Could not tell who you are: " and the resolver's message; the menu at the bar's foot says "Could not tell who you are" and asks again every 10 seconds.

## Developing

In the repo, `pnpm --filter @sanoma-ai/app build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` and `./build` entries). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: FSL-1.1-ALv2.
