# @sanoma-ai/app

A web UI for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces: it renders from `describeConfig(config)`, the config's ledger store and Postgres. The only workflow code it reads is each workflow's `run`, once at start, to draw its outline. It runs no workflows itself. The page talks to the server through TanStack Start server functions, its only HTTP surface besides the login's routes and the GitHub App's manifest flow (`/setup/github/`), and on a [public site's](#public-sites) own host only two of them, `callFn` and `getActor`, beside the site's login's routes; scripts and agents reach the same runs through [`SanomaClient`](https://www.npmjs.com/package/@sanoma-ai/workflows#building-your-own-ui), over the same Postgres.

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

A company repo's `sites/<name>/routes/` are TanStack Router file routes the app serves under `/sites/<name>/`, inside its shell. The package ships its source for that, and a Node-only entry, `@sanoma-ai/app/build`, which the `sanoma` bin calls:

```ts
import { buildApp } from "@sanoma-ai/app/build";
import { startApp } from "@sanoma-ai/app";

const { distDir, built } = await buildApp(repo, { log: console.log });
const app = await startApp(config, { distDir });
```

`buildApp(repo)` builds the app's routes and every site as one TanStack Start build with the repo as Vite's root, and writes only under the repo: `.sanoma/app/routeTree.gen.ts`, Vite's cache in `.sanoma/app/vite/`, and the build in `.sanoma/app/build/<key>/` (`client/` and `server/server.js`), where the key covers the app's version and source directory and every file under `sites/` and `content/`. All of `.sanoma/app/` is ignored by its own `.gitignore` (`*`), which Tailwind's scan of the repo honours too, so a build never reads its own output, whatever the repo's `.gitignore` says. A build with the same key is reused (`built: false`), and a new one is built beside it and moved into place, so an app serving the old one keeps it. The server bundle holds everything but the runtime (`@sanoma-ai/workflows`, `@sanoma-ai/bridge`, DBOS, `pg`, `zod`), which it imports by file URL, resolved from `runtimeFrom` (by default this package's own `package.json`), so the worker and the app share one copy.

- A site is client code: a site importing the runtime, a connector, DBOS, `pg` or a `*.server.*` file fails the build with "Import denied".
- A site imports React, TanStack's packages and this app as the app does, from the app's own install: the company repo depends only on `sanoma`.
- A folder is a site when it has `routes/` and its name is one URL segment (`/^[a-z][a-z0-9-]*$/`); `sitesOf(repo)` lists the sites and the refused folders, which the build logs and leaves out. Two pages claiming one path fail the build, naming the path and both files.
- `writeSiteFiles(repo)`, which `buildApp` calls first, writes `sites/__virtual.ts` (the listing the route generator reads; committed, never edited), `sites/tsconfig.json` when missing, `.sanoma/app/tsconfig.json` every time: the app's compiler options (`tsconfig.site.json`, shipped) with its React, TanStack and route tree, so `tsc -p sites/tsconfig.json` checks a site's links against every page; and `.sanoma/content.ts`, the types of [`content`](#content).
- `appViteConfig({ repo, runtimeFrom })` is the build's Vite config; `appViteConfig()` is this package's own (its `vite.config.ts`), the same pipeline with no sites. `appSources()` gives the app's `src` and `tsconfig.site.json` by real path.

`startApp(config, { dev: { repo } })` serves the app and the repo's sites from Vite's dev server instead of a build, behind the same `/healthz` and login: `appDevServer(repo, http)` from `@sanoma-ai/app/build` is the build's Vite config (`appViteConfig({ repo })`, so the route generator's options are the build's) in middleware mode, with hot updates over the app's own HTTP server, and Start's server entry imported for each request and handed the same context. On the server, Vite compiles the app's source and `sanoma` (whose `sanoma/site` and `sanoma/ui` are that source), and leaves the runtime to Node, the copy `startApp`'s context holds. An edit to a site or to the app's source shows without a reload, a Tailwind class in a new file under `sites/` is in the app's stylesheet and each site's own, and a new site folder is live once it has a route file; a change to `sites/__virtual.ts` itself needs a restart. It writes the sites' generated files and Vite's cache under `.sanoma/app/`, and no build. It listens on this machine only: the hot updates' websocket does not pass the login, so `startApp` refuses `dev` with any other `host`. `dev.onFileChange`, when given, is called with each file the dev server's watcher sees added, changed or removed (`sanoma` writes `.sanoma/api.ts` again on a change to what the config is read from).

A company repo is an ES module package (`"type": "module"`, as `sanoma init` writes it): Vite names the server entry `server.mjs` otherwise.

### A site's imports

A site's route file imports `createFileRoute` from `@tanstack/react-router` (the route generator rewrites the path there, and only there) and the rest from `sanoma/site`, which is this package's `@sanoma-ai/app/site`: the app's own router's `Link`, `Outlet`, `useNavigate`, `useParams`, `useSearch`, `useRouter`, `useRouterState`, `getRouteApi`, `linkOptions`, `redirect` and `notFound` (and their types), `defineSite`, `api` with `ApiError` and `errorBodyOf` ([Calling operations and workflows](#calling-operations-and-workflows)), `content`, the repo's Markdown ([Content](#content)), and the pieces that talk to the app, `RunForm` and `useActor` ([The kit and RunForm](#the-kit-and-runform)). How a page looks comes from `sanoma/ui`. `sites/<name>/site.ts`, optional, names the site:

```ts
// sites/help/site.ts
import { defineSite } from "sanoma/site";

export default defineSite({ title: "Help desk" });
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

A site for visitors rather than people says so in `site.ts`: `defineSite({ title: "Website", public: true, login: "auth0" })`. `public: true` makes it a public site, served at the root of its own host to visitors; `login`, for a public site only, names the connector in `sanoma.config.ts` whose login half signs a visitor in (`withSetup`'s `login`, in [the workflows README](https://www.npmjs.com/package/@sanoma-ai/workflows#usage)), and without it every page runs as `anonymous`. `sanoma` reads both without running `site.ts`, so the file's default export must be `defineSite({ … })` written out, each a literal; `sanoma check` names what it cannot read or check. A public site is served at the root of its own host too ([Public sites](#public-sites)).

### The kit and RunForm

A site imports how its pages look from `sanoma/ui`, which is this package's `@sanoma-ai/app/ui`: the app's own components, so its pages look like the app's (Tailwind's classes and the theme's tokens apply to a site's files too). It is presentational only: nothing in it talks to the running app (its queries, server functions, actor or config), so it could ship as a package of its own. It is an explicit list, and nothing else of the app is public:

- the shadcn components the app is built from: `Button`, `Input`, `Label`, `Textarea`, `Checkbox`, `NativeSelect`, `Slider`, `Badge`, `Separator`, `Skeleton`, `Spinner`, and the parts of `Field`, `Card`, `Alert`, `Table`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Tooltip`, `DropdownMenu`, `Empty`, `Item`, `ButtonGroup`, `Collapsible`, `Breadcrumb` and `Avatar`; and sonner's `toast`, shown by the app's toaster;
- the app's own pieces: `PageHeader` (a page's `<h1>`, its `title`), `Region`, `Facts` and `Fact`, `Tip`, `ButtonLink`, `ToneBadge`, `toneBadge`, `effectBadge`, `StatusDot` (and the `Tone` type), `Notice` and `Nothing`;
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

![A site's page in the app: the Sites panel, a Region of Facts and the announce workflow's RunForm](https://github.com/Sanoma-AI/sanoma/raw/main/.github/assets/site.png)

A site's page inside the app's shell: the kit's `Region` and `Facts`, and `RunForm`, from `sanoma/site`, drawing announce's fields from its schema.

With sites, the sidebar's bar has Sites, linking to the first site's home. Its panel lists each site under its title (its folder's name without one) with its pages, each named by its route's `staticData.crumb` or its path under the site (a page with a path parameter is left out), and a site's page starts its crumbs with the site's title. `@sanoma-ai/app/site` and `@sanoma-ai/app/ui` ship as source (`src/site.ts`, `src/ui.ts`), compiled by Vite in the company's build; they hold nothing server-side (a server function is a fetch in the browser).

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

/* On the site's own host only: light only, where the document follows the visitor's light or dark. */
[data-site="www"] {
  color-scheme: light;
  background: #f5f6f4;
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
- Its utilities are a layer inside the app's (`utilities.<name>`), scanned from the site's folder only (`source("./")`): inside the app, the app's own utilities win over the site's, so the site's `hidden` leaves the sidebar's `md:flex` alone. Imported into `utilities` itself, the site's would override the app's responsive variants, and hide the sidebar. A site that uses components from outside its folder names them for the scan (`@source "../../components";`).
- `tailwindcss` and its `theme`, `utilities` and `preflight` resolve to the app's install, as the app's own stylesheet does: the repo installs nothing for them. A `@plugin` is a package the repo installs itself (`pnpm add @tailwindcss/typography`); what it imports of `tailwindcss` (`tailwindcss/plugin`, `tailwindcss/colors`) resolves to the app's install too.
- Its theme is Tailwind's default, not the app's: a class both use where the app's theme differs (`rounded-lg`, `font-sans`) takes the app's value while the page is shown inside the app, and the site's on the site's own host. Its theme variables are another matter: one both name (`--font-sans`, once a site's class uses it) takes the site's value inside the app, in the app's chrome too. A site keeps its own tokens under names the app does not use (`--font-body`, not `--font-sans`), so its classes look the same in both and leave the app's alone.

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

- **Not found:** a loader's `notFound()` is drawn by the nearest route, from the page up, with a `notFoundComponent`, in place of that route: give the page one, as above, and the site's layout one too (`sites/www/routes/route.tsx`), which draws a path no page has inside the layout. A page whose route has none draws in the layout's place when the layout has one, and, with neither, the app's not-found notice takes the page's place (on a public site's own host, [a plain page](#public-sites)). Its head runs with no `loaderData`.
- **Front matter** is YAML between a first line `---` and the next `---` line, read as YAML 1.2, so an unquoted date stays a string. A file whose front matter is not a mapping is left out, and `sanoma check` reports it at its line.
- **HTML** is rendered at build with `marked` (GFM), so no Markdown library ships to the browser. Raw HTML in a file passes through: content is reviewed as code is. The kit has no styles for it; give the `article` your own classes.
- **Drafts:** an entry whose front matter has `draft: true` is there while `sanoma` serves the sites from its dev server, and never in a build: not on a page, not in any file sent to the browser.
- **Loading:** the content is one chunk of the browser's bundle, loaded on the first call, and part of the server's render, so a loader's `await content.posts.list()` adds no request. A change under `content/` is a new build (the build's key covers it). On the dev server, a file saved under `content/` shows on the next render of an open page, with no restart.
- **Types:** `.sanoma/content.ts`, written with the sites' generated files (and again on the dev server when a file under `content/` changes), types `content` by augmenting `Register`, as `.sanoma/api.ts` types `api`: each kind's `data` is the union of its files' front matter, drafts included, a key in every file required and `?` otherwise; strings, numbers, booleans and `null` as themselves, a list as an array of its items' types, a mapping as an object merged the same way (so rows of a table in the front matter share one type). Values are never types: `status: draft` is a `string`. Until it is written, `content` is untyped.

`readContent(repo, { drafts })` and `contentTypes(kinds)`, from `@sanoma-ai/app/build`, are what the build and `sanoma check` read with: the kinds and the problems, each `{ file, line, column, message }`, and the text of `.sanoma/content.ts` (`CONTENT_TYPES`).

### Public sites

A public site (`defineSite({ public: true })`) is served at the root of its own host, and at `/sites/<name>` on the app's host as any site is, in the app's chrome, for the people who run it.

- **Its hosts.** `<name>.localhost` on the app's port (a browser sends `*.localhost` to this machine, and the loopback login lets it through), and the domain `startApp`'s `domains` gives it (`{ www: "sanoma.example" }`; the `sanoma` bin reads `SANOMA_DOMAINS`, which a host resource's `domains` sets). A domain naming a site that is missing or not public is warned about and served nowhere. `app.sites` gives each public site served, by name, at `http://<name>.localhost:<port>`; the Sites panel links to the site's domain, else, on a page of this machine, to `<name>.localhost`.
- **One build, two routings.** On the site's host the router mounts the site at `/`: a page's `<Link to="/sites/www/blog">` is `/blog` there and `/sites/www/blog` on the app's host, and a path outside the site, `/workflows` among them, is the site's not-found page, a 404. The document there is bare: charset, viewport, `color-scheme: light dark` (the visitor's light or dark), a body with no margin, in a layer ahead of the site's stylesheet so any rule of the site's overrides it, and `<html data-site="<name>">`, which a site's stylesheet may scope its own host's rules to ([A site's own stylesheet](#a-sites-own-stylesheet)); no app stylesheet, theme, icon, chrome or config, which the app's host loads in chunks of their own. The site's layout sets its own icon and stylesheet in its `head`, and each page its title.
- **Not found and errors.** A page not found there, a path no page has or a loader's `notFound()` ([Content](#content)), answers 404, titled "Page not found" unless a route of the site gives a title: a title in the layout's `head` stays on every page, a page not found too, so give each page its own. Where the site draws no `notFoundComponent` or `errorComponent`, the page is a plain one of the app's (a heading and a line, no app styles), and an error's message stays out of it.
- **Its front door.** A request to the site's host never reaches the staff login, and its cookie and `x-sanoma-actor` header are ignored there. The site's login (`defineSite({ public: true, login: "<connector>" })`, a connector's login half) answers `/auth/<connector>/*` and verifies a visitor, who acts as `visitor:<connector>:<subject>` in the group `visitors`; anyone else, and everyone on a site with no login, acts as `anonymous`. Only `callFn` (a site's `api`) and `getActor` (`useActor()`, which says nobody for `anonymous`) answer there: any other server function is not there (a change's 404, a read's not-found), nor any other `/auth/` route (404), and a method but GET, HEAD and POST is a 405. Every request there carries `x-sanoma-client-ip` (`CLIENT_IP_HEADER`), set from the socket, a client's own copy overwritten. What a visitor may call is the policy's, by a `permit` ([above](#calling-operations-and-workflows)).
- **Its login.** `startApp` makes each public site's login half once it listens, before it resolves, with the company's database, a key of its own to sign its cookies with (derived from `SANOMA_SECRETS_KEY` for `login <connector>`, so a login like Better Auth needs no secret set), its stored secrets and the site's origins (`http://<name>.localhost:*`, and `https://<domain>` with a domain); a request that comes first waits for it, and `app.close()` closes it. A public site whose `site.ts` has a problem (its login may be one not read), or whose login fails to start, is served on no host, a 503, and the app's log says why; the app itself starts, so the connector's page, or `SANOMA_SECRETS_KEY` in the environment, can give what the login lacks.
- **Not on a public host:** the app's chrome and what it provides, so a site there brings its own toasts and has no `useDensity()` (it throws); `RunForm` and the will-ask preview, which read the config and link to the app's pages.
- **Later:** a `RunForm` on a public page; rate limits; caching headers and prerendering for anonymous pages; the public host's own pending view; an anonymous id per session (every anonymous visitor is one principal now).

## Screens

Five sections, in the sidebar's section bar: Inbox, Workflows, Resources, Connectors and Go live; then Sites when the company has sites, Data when it has collections, and Permissions when it has policies (`policies/*.cedar`). The app opens on Workflows, its home, which lists each workflow and how its last run went. Old links still work: `/` redirects to `/workflows`, `/runs` to its All runs view, `/runs/<id>` to the run's page under its workflow, and `/start?workflow=<name>` to that workflow's page with its New run panel open, which says if the workflow is unknown (`/start` naming none, to `/workflows`).

- **Workflow** (`/workflows/<name>`): one workflow's page, which takes the window's full width (the other pages keep to a reading width). Its header names the workflow, with **New run** at its end (none for a retired workflow), which opens the New run panel on the pane that shows. The sidebar's panel drills into the workflow: **← Workflows**, back to the Workflows panel, the workflow's title and name, **Workflow**, its own pane, then its latest 50 runs, newest first: each with its status (and, while it waits, the first approval it waits on), a sandbox run's scenario, who started it and when, linking to its pane, the open one marked. The panel's **Show runs** menu shows all of them, or only live, sandbox, waiting or failed runs, kept in the URL as `?runs=`, which the panel's links keep: live and sandbox are picked from the latest 50 (so the panel says it found none, or lists those it found, among the latest 50), while waiting and failed are the latest 50 with that status, however old. The runs refresh every 2 seconds while one of them can still change, else every 30 seconds, and at once when you start a run or decide an approval. The panel ends with **All runs**, the Workflows page's All runs filtered to the workflow. A workflow the config no longer has keeps its page while it has runs: its header names it, its own pane says it is gone, and its runs draw a graph with only its name. With no runs either, its page is not found.

  Both panes are one view of the workflow, drawn by its design or by the run picked in the panel. Under a run's status and a notice for what it waits on (who, and for which approval, with **Show approval** to select it) or why it failed, the graph's card sits beside an inspector, or above it while the pane is narrow; under them, the **Code** tab (and on a run's pane **Ledger**, open at first). Clicking a node selects it: the graph rings it, Code marks its lines, and the inspector shows it, closing New run if it is open. Clicking a line in Code selects its node, and a ledger row's **Show in graph** button selects the node it is drawn as. The inspector shows, first match wins:
  - **New run**, while the URL has `?new` (its close button drops it), on either pane: two links, **Live vendors** and **Sandbox**, each its own URL (`?scenario=<name>` is Sandbox with that scenario, none is Live), then the form. `/workflows/<name>/new`, the old New run URL, redirects here, keeping `?scenario=` and `?runs=`.
    - **Live vendors**: says which vendors the run calls for real and what the policy will do on a run you start (the will-ask line, as `RunForm` has it), then the form, built from the workflow's input schema: text, date and time (in your browser's time zone, shown as its ISO text until the page has loaded), numbers, yes/no, choices, lists with Add and Remove, and objects one level deep; anything else is entered as JSON. Optional fields left empty are left out, so the schema's defaults apply. The server checks the input with the workflow's schema and its complaints appear on the fields they name. **Start run** starts it and opens the run.
    - **Sandbox**: a menu of the workflow's [scenarios](https://www.npmjs.com/package/@sanoma-ai/workflows#scenarios-and-sandbox-runs) (**Sandbox** opens the first; with none, it is disabled and says so), and the form showing the chosen scenario's input with its controls disabled and no Add or Remove, since a sandbox run takes its input from its scenario. **Start sandbox run** starts it and opens the run, as you (a scenario's `Given ada is acting` is for `sanoma check` and tests, so the app never records a run as someone who did not start it): nothing leaves Sanoma, the fakes answering its calls. The scenario's lines of its feature file are behind **Scenario**, and the workflow's graph badges each operation a `Given` seeds ("seeded") or makes fail once ("fails", for `fails once`, `is rate limited once` and `loses its reply once`), and one a `Then` expects to be called ("expected"), not called ("not called"), denied by the policy ("must deny") or held by it ("must hold"), matching an outline's computed segment (`*`) as the run graph does. A scenario the feature files do not have says so. The scenarios are read again every 5 seconds while the page is open and when its window regains focus, so an edited feature file shows up without a restart; a file that cannot be read says why at the top of the workflow's pane. The app decides nothing: the run's approvals wait for people, as a live run's do. Each sandbox run calls its own copies of the fakes, so several run at once, and one waiting on an approval holds up no other.
  - **The selected node**: its kind, its step's name (when its call gives one) and label; for an operation, its id, effect and vendor and what it does; and **Lines a–b** of the source, which opens Code. On a run's pane, also the node's ledger records (a held call's with the policy's request and decision, an approval's with its decision), and the approval it waits on with **Approve** and **Reject**, so it is decided in place.
  - With nothing selected, **About** on the workflow's pane: what it may call, its operations with their effects, its built-ins, its input and **Used by**: each site's page that calls it, under the site's title, through `RunForm` or `api`, linking to the page (a component's file, which is no one page, by its file); on a run's pane, the run's facts (who started it, when and its id) and its approvals, each with the operations it lets through (badged by effect), and **Approve** and **Reject** with an optional note while the run can still read a decision. When the run has not read a decision within 5 seconds (no worker is running, say), it stays queued and the run reads it when it next runs: the dialog closes and the page shows the decision as queued, with Approve and Reject disabled for that approval, until the run's status changes.

  The panes:
  - **Workflow** (`/workflows/<name>`): the workflow's outline (see [Outline](#outline)), and its source under Code.
  - **Run** (`/workflows/<name>/runs/<id>`): the run's status (a sandbox run badged `sandbox · <scenario>` beside it) and its graph (see [Run graph](#run-graph)). Its Ledger tab lists a sandbox run's **Checks**, drawn as the ledger's rows are: each `Then` of its scenario, which Cucumber runs against the ledger, each on its own, met, failed with why, or "not yet" while its answer can still change (until the run ends, unless it expects a call that has been made); when the run's scenario is no longer in the feature files, or they cannot be read, Checks says why instead. Then the ledger as a timeline: the start, each operation call with its effect, the policy's decision, duration, input and output, each approval asked, decided or ignored, and how it ended; a sandbox run's says how many calls it was seeded with. A run of another workflow opens under its own.

- **Inbox** (`/inbox`): the open approval, with the list in the sidebar's panel. Two links atop the panel pick the list, each its own URL (`?show=`): **For you**, the pending approvals you may decide (the default once the page knows who you are), and **Everyone**, every pending approval (the default until then), both newest first and with how many they list; under it, **Decided today**, the approvals decided since midnight (your browser's) in the latest 50 runs, and at the panel's foot **All decided** (`?show=decided`), which lists the approvals decided in the latest 50 runs, latest first. Each row has the approval's title, how long ago it was asked (a decided one: its decision, and how long ago it was made), its workflow and who started the run, and opens it (`?approval=<runId>/<approvalId>`), marked while it is open. The open one, by default the first for you, else the first, is a sentence saying whose run of which workflow wants to do what (the operations it lets through, such as "publish a post in Ghost"), above its card, with the same controls as on its run's page. Once you decide, it leaves the list and the next one opens; with nothing for you, a link shows those waiting on others. Refreshes every 5 seconds.
- **Workflows** (`/workflows`): the home. Its header says how many workflows the app has, with **All runs** and **New workflow**; under it, a card with the config's version and whether the repo has policies (and their version). A table lists every workflow in the config: its title (linking to its page), its name, built-in for the built-in `drift` (which starts like any other, with no input), how it starts (by hand), the vendors its operations call, in order of title, its last run's status and when, and how many approvals its runs wait on, on anyone (and how many of them are for you). Links above it, each its own URL with how many it holds, pick the rows (`?filter=`): **All**, **Waiting on you** (runs waiting on an approval you may decide), **Failed last run** and **Built-in**. What it may call, its built-ins, its input and its outline are on its page. **All runs** (`?view=runs`, with **All workflows** back) lists the latest 50 runs of every workflow, newest first: each with its workflow (linking to the run's page under its workflow, the run's id as its tooltip), a sandbox run's badge, its status, who started it and when, how many approvals it waits on, and a failed run's error. Its **Status** menu shows only the runs with that status, the latest 50 however old, kept in the URL as `?status=`; `?workflow=<name>`, which a workflow's panel links to, shows only that workflow's, named beside the menu with a button that removes it. The table refreshes as a workflow's panel does. **New workflow** opens a dialog saying how to add one to the repo (a file under `workflows/`, listed in `sanoma.config.ts`, which the app shows once it restarts); drafting one from a description is coming.
- **Resources**: each resource the data files declare (its name, type and vendor, the declaration it comes from, which opens in its file below the table, marked, and the vendor object the lockfile binds it to, its id cut short), with the latest drift check's verdict: clean, drifted (with each field that differs, as declared and as the vendor holds it, shown under its row), gone, absent (not bound yet, and whether its identity found an object), error (and why), or not checked. Bindings in the lockfile that no data file declares are listed under the table, each with its key, type and id: apply asks whether to forget each or delete its object. **Apply** starts the built-in `apply` workflow on every declaration, and goes to its run; the config registers it beside drift. Apply holds its plan for a person: wherever an approval's details carry one, the Inbox and the run show it as the change view: problems in the data files, each change to the lockfile apply did not make in plain words ("points store at a different project: abcdefgh… → wxyzabcd…"), then the steps by action: creates with their planned fields (what the vendor fills in is "known after apply"), updates and replaces with the fields that differ (and, for a replace, the fields that cannot change in place), binds (found by identity, or given), gone objects and orphaned bindings with the question each asks, and the unchanged, folded. Each drifted field has **Adopt**, which writes the value the vendor holds, as that check's report has it, into the data file (`setFields`: only that declaration changes), commits it when `startApp` is given a `source` (the company's repository; without one it only writes the file), and starts a drift check, which reads the file as it now is. **Run drift** starts the built-in `drift` workflow, which reads the data files as they are then; the page reads the drift runs as a workflow's panel does, every 2 seconds, links to the latest run, and shows the report of the latest that finished. Problems in the data files show above the table, each at its file, line and column, since their resources are left out: those the app found when it started, and any the last check found. The declared list is the one the app read when it started (`describeConfig`), so a data file changed since shows in the last check's rows and problems, but its declaration opens only once the app is restarted (to do: read the files again when they change).
- **Data** (`/data`): the config's collections, each with its title, name, key and how many fields it has, linking to its grid; the sidebar's panel lists them. **A collection** (`/data/<name>`) is its records in a grid, the page's full width: a column per field, in the collection's order, then when each record was saved and by whom. A field's heading sorts by it, ascending, then descending, then by key again (`?order=`, `-` for descending); above the grid, **<key> starts with** keeps the records whose key starts with what you type (`?key=`), each enum field has a menu of its values (`?where=`), and **Show at most** sets how many it reads, 100 at first, up to 1000 (`?limit=`); it says so when there may be more. A record saved before its fields changed, which they now refuse, is badged **needs fixing**, what they refuse in its tooltip. **Add record**, or a record's row, opens the record form beside the grid (`?new`, `?record=<key>`), drawn from the collection's fields as a start form is from a workflow's input: text, a number, yes/no, a choice for an enum, a date input for a date (one a workflow saved with a time shows as a date and time), and a person as their id, a new record's people starting as you; an edit's key cannot change. **Save** saves it, and **Delete**, once confirmed, deletes it. Every read and change is the collection's operation (`data.<name>.list`, `.save`, `.delete`) called through `api` as you, so the policy decides each and a save or a delete is in the ledger: a denial shows on the form; a call the policy holds for an approval says **Held for approval**, linking to its run of the built-in `call` workflow (`/workflows/call/runs/<runId>`), which makes it once approved in the Inbox; what the fields refuse shows under them. The header names the collection, its operations' prefix and where `resources/data.ts` declares it (opening it on the Resources page), and **Used by** lists the workflows whose `uses` name one of its operations, then the sites' pages that read or write it, as a workflow's page lists those that call it. The Resources page lists the collections too, each linking here. History, import and export are not there yet.

  ![A collection's grid: the outbound leads sorted by stage, a record open in the form beside it](https://github.com/Sanoma-AI/sanoma/raw/main/.github/assets/data.png)

- **Permissions** (`/permissions`): what the policy answers someone in no group, in each group (the declared ones, `agents` and `visitors`) and `anonymous` (Anonymous, a public page with nobody signed in), across, for the start of each workflow, with each operation it uses under it, and each operation a person may call directly down, with the policies' version above it; the sidebar's panel says the same with how many groups, workflows and operations it has. Each cell is the policy's answer for someone in that group alone (an agent acting for someone, so a hold for `on-behalf-of` asks "whom it acts for"; a visitor, denied a start and a direct call no `permit` names, and allowed an operation in a run), the input unknown: allow (muted), hold (with whom it asks), deny, or depends (the input decides); a hold, a deny or a depends opens the rule behind it in a sheet (its id, its file, its `@title` or `@reason`, and for a hold whom it asks), with Show the rule. Under the grid, each policy file is shown read-only, titled by its path, as a workflow's Code tab shows its source (plain: the app has no Cedar grammar); Show the rule marks that rule's lines there. Nothing here is edited: the rules are `policies/*.cedar`, and the people and groups the Resources page lists.
- **Connectors**: each vendor the config's operations are from, by title, with its logo and id (never the built-in `sanoma` and `data`, which call nothing outside: a workflow's vendors and New run's "Calls … for real" leave them out too), how many operations it has and how many workflows use it, and, when its drivers declare environment variables, whether it is configured or how many variables it needs, each linking to its page, under Installed, with its tier (Official for an `@sanoma-ai/` package, else Community). Under Available, the connector packages on npm that the config does not install, found by the `sanoma-connector` keyword and shown by the `sanoma` field of each one's latest version (title, and logo files the server reads from jsDelivr and checks as an installed connector's are, shown as images only), with its tier, description and version; nothing is stored, and npm is read at most every 10 minutes. Choosing one opens the steps to add it (`?add=<package>`): `pnpm add`, the import in `sanoma.config.ts`, then its credentials; there is no install button. When npm cannot be reached, a notice says only the installed connectors show.
- **Connector** (`/connectors/<vendor>`): links to its connector's npm package and source (from `defineConnector`'s `package` and `homepage`, when it gives them), its resource types, and each operation with its effect, whether it is safe to retry, its description, its contract (input and output as JSON Schema), its scenario `phrases`, the scenarios with a step about it (each marked as seeding it, making it fail, expecting it or saying it must not be called, and linking to its workflow's New run in Sandbox mode with it chosen), and the workflows that may call it; a feature file that cannot be read says why above the operations, as on a workflow's page. A vendor with workflow operations whose connector attaches no fake (its `VendorEntry`'s `fake`) says "Its connector attaches no fake" once, above its operations; one with only a resource type's `read` and `import` needs none, since those read real state and a sandbox run never calls them.
- **Go live** (`/setup/connect`): connects the company's GitHub and Supabase, the first step of going live. **Create GitHub App** (with an organization's login, or empty for your personal account) goes to `/setup/github/manifest`, a page that posts the App's manifest to GitHub (administration, contents and pull requests: write; push and pull request events, its webhook off until the app receives them; its OAuth callback the login's `/auth/github/callback`), with its state and who asked in a signed, httpOnly cookie (nobody signed in is sent back here, told to say who they are first). You name and create the App on GitHub's page; GitHub sends you back to `/setup/github/callback`, which checks the state, exchanges the code (`POST /app-manifests/{code}/conversions`) and stores the App's id, slug, client id and secret, webhook secret and private key as encrypted credentials set by who asked (`SANOMA_GITHUB_APP_ID`, `SANOMA_GITHUB_APP_SLUG`, `SANOMA_GITHUB_CLIENT_ID`, `SANOMA_GITHUB_CLIENT_SECRET`, `SANOMA_GITHUB_WEBHOOK_SECRET`, `SANOMA_GITHUB_APP_PEM`), then comes back here saying how it went (sign-in uses the new client once the app restarts on a host beyond this machine). The page then shows the App's slug with **Install**. An installation token can create a repository only in an organization that granted the App administration access, so for a personal account the page also takes a token of your own, `GITHUB_TOKEN`; and Supabase's access token, `SUPABASE_ACCESS_TOKEN`. Both are set as on a connector's page (the same rows, so a connector that declares them shows them too), whether or not a connector declares them; the page never shows a value.
- **Connect an existing repository or database** (`/setup/existing`, linked from the connect page): takes a GitHub repository (`owner/name`, of the owner the GitHub connector reads) and/or a Supabase project's ref, reads each through its type's import (in the app's process, before any declaration names it; apply's own import, when it binds, is in the ledger), and writes `resources/sanoma/infra.ts` from what was read: the repository's name, description and visibility; the project's name, organization and region, with its database password declared as a generated secret, which Supabase never reads back, so the next apply that changes the project sets a new one. In a repository without a remote, the file is committed where the checkout is; with one, on a new branch, `setup/connect-existing`, checked out, and the page shows the diff: merging it is the approval. Then it starts apply with `bind` and `only` for those declarations, which binds them in the lockfile (committed on the same branch) and creates nothing. Refused when `infra.ts` or the branch is there already.

For a vendor whose drivers declare the environment variables they read (see [Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)), the connector's page lists them under **Credentials**, above its operations: each variable's name, its description, whether it is optional, and its status: set, missing, or invalid with the reason. A variable the app's environment sets says "set in the environment" and has no controls, since the environment wins. Any other has **Set** (**Replace** once set), which opens a small form with the variable's description and a password field: **Save** stores the value in the runtime's database as you, and running workers load it without a restart; the schema's reason for refusing a value shows under the field. A stored value reads "set by <who> · <when>" and has **Clear**, which deletes it. The page never shows a value, and the form forgets what you typed once it closes. The statuses are read when the page asks, from the app's environment and the stored values, so run the app on the worker's environment.

The screens share one shell: a sidebar and, above the page, a breadcrumb (the page; or Workflows, the workflow's title and, on a run's pane, the run's id; or Connectors and the connector's title). The sidebar is a bar of the four sections, each an icon with its label under it (Inbox badged with how many approvals are pending), the current one marked, and beside it a panel that lists the current section: the Inbox's approvals, the workflows (**Find a workflow** filters them; those whose runs wait on an approval you may decide first, with how many, then the rest by their last run, each with its status's dot; **New workflow**; and **See all**, the Workflows page), or, on a workflow's page, its runs. Resources and Connectors have no panel, so their pages get the room. The panel's button, the sidebar's rail (its right edge) or Ctrl+B (⌘B on a Mac) folds the panel away, leaving the bar, and opens it again, and the sidebar opens as you left it on your next visit (it keeps that in a cookie, `sidebar_state`). While no panel is docked (the panel folded, or on Resources or Connectors), resting the pointer on Inbox or Workflows in the bar, or reaching it with the keyboard, peeks its panel over the page (Tab moves into it); it closes as the pointer leaves (after a moment, so a move across to it keeps it open), as you follow a link in it, or on Esc, which puts the keyboard's focus back on its section; in its own section, its **Pin** docks it (elsewhere, its section's link goes there). On a phone the sidebar is a sheet over the page holding the bar and the panel (the workflows' in a section with no panel of its own), opened from the toggle beside the breadcrumb, that closes as you follow a link or tap beside it. **Density**, in the menu at the bar's foot under the theme, switches the page to **Compact**, a tighter density for people who live in the app: the page beside the sidebar a quarter tighter in every padding, gap and control (its icons too; the text keeps its size), half the gap between a page's regions, a lower graph card and source. Switching it on folds the panel once (not on a phone); switching back to **Comfortable** leaves the sidebar as it is. The browser remembers the density as it does the sidebar, in a cookie (`sanoma_density`), so the server renders the page in it from the first paint. The menu at the bar's foot, under your initials, has who you are (and Change name, under the default resolver), the theme (light, dark or the system's, which the browser remembers) and the density. The screens are built with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`, from `components.json`) on Tailwind CSS.

### Run graph

A run's pane draws the run as a graph, left to right: the start, each operation call (its effect, the policy's decision, its duration or error), each sleep, each approval the workflow asked for, and how the run ended, or a dashed end while it has not. An approval the policy asked for sits on the call it holds. The calls of one `ctx.all` branch out side by side and join again after it. Each node's colour says how it went: done, failed or denied, waiting on a person or a sleep, or running. The graph is read from the ledger alone, so it shows what happened, not what the workflow may still do, and it redraws as the page polls. Clicking a node shows it in the inspector, scrolls to its record while the Ledger tab is open, and marks the call in the workflow's source under **Code**: the one the worker placed the call at, which the record names (`node`), when the source still has that call there, so a loop's every pass marks its one call, and a call from a ledger written before calls were placed, or whose file has changed so that another call or none is where it was, marks nothing rather than a guess. Clicking a call in the source selects its node: of a loop's passes, the latest. A sleep is labelled with the time it ends, in UTC, as the ledger shows times, so the server and every browser draw the same text. It is drawn with [React Flow](https://reactflow.dev) in the browser only; the server renders a placeholder of the same size, the graph's code loads, once, only on the pages that draw a graph (a workflow's page and Workflows), starting as the page's data loads, and each graph is drawn when it first scrolls near the screen. A graph pans sideways with the scroll wheel or a drag; its zoom control (React Flow's zoom slider, in the bottom left corner) zooms out and in, shows the zoom (a click sets it back to 100%), and fits the whole graph in view.

A `ctx.all` draws as one lane per member, top to bottom in member order, between the step before it and the step after: in a run that posts to three vendors at once, sleeps, then reads two results at once, the graph shows three lanes, the sleep, then two lanes, each lane coloured as its call went (a call the policy holds waits in its own lane). While a `ctx.all` is the last thing the run has done and the run goes on, each member that has recorded nothing yet has a dashed "not started" lane. Members that never ran, after one failed, or once the run has moved past the group or ended, have no lane. An operation whose call has a [step name](../workflows/README.md#step-names) other than its id says the name, with the id on the line below; a sleep with a name says it the same way, above its clock and the time it ends. A long loop label is cut short in its box; hovering shows it whole.

### Outline

Each workflow card on the Workflows page, and a workflow's page, draw the workflow's shape before it runs, from the `outline` that `describeConfig` (`@sanoma-ai/workflows/describe`) reads once per workflow when `startApp` starts; the source under a workflow page's Code tab is the workflow's file as it is when the page asks for it. It is the run graph's drawing without colours: the operations (with their effects), approvals and sleeps the body of `run` calls, a `ctx.all` as lanes, a loop or a `ctx.all` over a list as a box labelled from its code ("for each of subscribers", "repeat while more") (the line into the box goes on inside it to its first nodes, and its last nodes join the line out), an operation or sleep by the name its call gives, and an `if` or `switch` as a diamond that splits into one lane per case, plus a lane marked "otherwise" when the run can go by without any of them (an `if` without `else`, say). It is a reading of the source, labelled so: "Read from the body of run; the functions it calls are not shown, even those defined in it". When the source cannot be read the card says why instead.

## Login

`GET /healthz` answers `ok` before any login, whatever host it is addressed to: a host's probe that the app is up, and nothing more.

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

The OAuth client is the company's GitHub App's, with `<the app's URL>/auth/github/callback` as its callback URL. The session is a signed, httpOnly cookie that lasts 12 hours, keyed from `SANOMA_SECRETS_KEY`, which must be set (`githubLogin` throws, naming it, when it is not); who may sign in is read on every request, so removing someone from the people file takes effect at once. The person acts as declared, by their id and the groups that list them, so approvals and the ledger name them. The menu at the sidebar's foot shows the login, your groups and Sign out. The `sanoma` bin builds this from `SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET`, and listens on `SANOMA_APP_HOST`; on a host beyond this machine, or with one of them set, one the environment leaves unset is read from the stored credentials, where creating the App on **Go live** put them.

### Your own

A `LoginProvider` is `{ name, check(listenHost), resolveActor, handle?, signOut? }`. `check` throws for a host the app may not listen on. `resolveActor` turns a request into who the login vouches for (`LoginIdentity`: `{ id?, email?, github? }`), or `undefined` to refuse a change; the app admits only the declared person it matches (`admitting`: by email, then GitHub login, then id), who acts as declared, so a provider's own roles or group claims never reach the policy. `handle`, when there is one, sees every request first: it answers its own routes under `/auth/<name>/` and any request it will not let through, and returns `undefined` for the rest. `signOut` is the path the page POSTs to to sign out, which `handle` serves; with it, the menu shows Sign out.

With a login provider, the page never asks for a name: it shows who the login says you are. An approval addressed to a group (`{ group: "finance" }`) can be decided only by someone the people file lists in it. The app calls `resolveActor` only for a request that needs to know who is asking, once per request. One that throws fails the change with a 500, logged as "Could not tell who you are: " and the resolver's message; the menu at the sidebar's foot says "Could not tell who you are" and asks again every 10 seconds.

## Developing

In the repo, `pnpm --filter @sanoma-ai/app build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` and `./build` entries). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: FSL-1.1-ALv2.
