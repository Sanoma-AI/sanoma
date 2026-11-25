---
title: The kit and RunForm
description: "Use Sanoma’s UI components on a site and embed a workflow’s start form."
sidebar:
  order: 4
---

Import visual components from `sanoma/ui`. These are the components the app uses, with no dependency on its actor, queries, server functions, or config. Only the listed components and helpers are public.

Site pages can use the app’s Tailwind theme tokens, including `bg-card`, `text-muted-foreground`, and `bg-primary/10`. The app theme omits the default palette, so `bg-white` and `text-red-500` generate no styles there. To use that palette, give the site [its own stylesheet](/sites/stylesheet/) without importing [the kit’s theme](/sites/stylesheet/#the-kit-on-a-site).

## What the kit exports

- the shadcn components the app is built from: `Button`, `Input`, `Label`, `Textarea`, `Checkbox`, `NativeSelect`, `Slider`, `Badge`, `Separator`, `Skeleton`, `Spinner`, and the parts of `Field`, `Card`, `Alert`, `Table`, `Tabs`, `Dialog`, `Sheet`, `Popover`, `Tooltip`, `DropdownMenu`, `Empty`, `Item`, `ButtonGroup`, `Collapsible`, `Breadcrumb` and `Avatar`; `CodeBlock`, `CodeBlockContent` and `CodeBlockCopyButton`, a block of code with a button that copies it (a command to paste); and sonner's `toast`, shown by the app's toaster;
- the app's own pieces: `PageHeader` (a page's `<h1>`, its `title`), `Region`, `Facts` and `Fact`, `Tip`, `ButtonLink`, `ToneBadge` (with `dot`, a status pill), `toneBadge`, `effectBadge`, `StatusDot` (and the `Tone` type), `Notice`, `Nothing`, and `FloatingCard` (the one card with a shadow, for a selection shown over a page's card, placed by its `className`);
- the hook `useDensity` (Compact or not).

## RunForm and useActor

Import `RunForm` and `useActor` from `sanoma/site`, alongside `api`. They connect the page to the running app.

- `RunForm({ workflow })`, the app's start form for a workflow, its fields drawn from the workflow's input schema;
- the hook `useActor()`, who is signed in (`actor`, `groups`, and `signOut` when the login has its own routes; the `ActorState` type).

`RunForm` links to the workflow and starts a live run. Validation errors appear beside the affected fields. After the run starts, the form stays on the page and links to the run’s graph, ledger, and approvals. If the config has no workflow with the supplied name, the form displays a notice.

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

![A site's page in the app: the bar, a Region of Facts and the announce workflow's RunForm](../../../assets/sites/site-page.png)

The page uses `Region` and `Facts` to display the site’s data. The fields in `RunForm` come from the `announce` workflow’s input schema.

## Sites in the app

The sidebar shows site tiles between **Workflows** and the Setup group. A tile uses the site’s title and icon and opens its home or first page. A site with parameters on every page has no tile. The tile stays highlighted while you’re on the site. The build includes only the Lucide icons named in `site.ts` and renders them on the first paint. An unknown icon falls back to the default for that kind of site.

Open **Data → Sites** (`/sites`) for the full list. The table shows each site’s folder, its app if applicable, and its pages. Page labels come from `staticData.crumb` or the route path. The list omits pages that require path parameters. For a [public site](/sites/public-sites/), it also shows the address and sitemap. Sanoma reserves `/sites` for this view and highlights **Data** there.

Vite compiles `sanoma/site` and `sanoma/ui` from source (`src/site.ts` and `src/ui.ts`) in the company build. Both entries are browser-safe. A server function call becomes a fetch in the browser.
