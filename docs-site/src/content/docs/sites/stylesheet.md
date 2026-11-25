---
title: A site's own stylesheet
description: "Add a stylesheet to a site, choose its Tailwind theme, and style Sanoma UI components."
sidebar:
  order: 5
---

The app’s stylesheet scans the company repo, so site pages can use Tailwind classes and the app’s theme tokens. To give a site its own look, add a stylesheet beside its routes and link it from the layout’s `head`. This also gives a public site a stylesheet to load on its own host.

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

## Tailwind layers and imports

- **Scope base styles.** Import `tailwindcss/theme` and `tailwindcss/utilities` individually. The full `tailwindcss` import includes preflight, which would restyle the surrounding app at `/sites/<name>`. Scope base rules to a site class such as `.www`. For rules that apply only on the public host, use `[data-site="<name>"]`. The public document renders `<html data-site="<name>">`. The app’s document omits that attribute.
- **Keep utilities in a sublayer.** Use `utilities.<name>` and scan the site folder with `source("./")`. The app’s utilities then take precedence inside the app. For example, the site’s `hidden` class leaves the sidebar’s `md:flex` intact. Importing into `utilities` directly can hide the bar by overriding responsive variants. Add shared component directories to the scan with a rule such as `@source "../../components";`.
- `tailwindcss` and its `theme`, `utilities` and `preflight` resolve to the app's install, as the app's own stylesheet does: the repo installs nothing for them. A `@plugin` is a package the repo installs itself (`pnpm add @tailwindcss/typography`); what it imports of `tailwindcss` (`tailwindcss/plugin`, `tailwindcss/colors`) resolves to the app's install too.
- Its theme is Tailwind's default, not the app's (until it imports [the kit's](#the-kit-on-a-site)): a class both use where the app's theme differs (`rounded-lg`, `font-sans`) takes the app's value while the page is shown inside the app, and the site's on the site's own host. Its theme variables are another matter: one both name (`--font-sans`, once a site's class uses it) takes the site's value inside the app, in the app's chrome too.

  A site keeps its own tokens under names the app does not use (`--font-body`, not `--font-sans`), so its classes look the same in both and leave the app's alone.

## The kit on a site

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
- The kit's colours are tokens by shadcn's names (the list is `src/ui.css`), in the theme layer, so any rule of the site's wins. Set them under `[data-site="<name>"]` for the site's own host and under the site's class for its pages inside the app, never on `:root`, which inside the app would recolour the app.

  A name that is another's there (`--popover` is `--card`, `--ring` is `--primary`) follows the site's value on its own host, but inside the app only when the site sets it too; and inside the app the kit's popups (dialogs, menus, tooltips), drawn outside the site's class, keep the app's colours.

- A `light-dark()` value follows the visitor's light or dark once the site says `color-scheme: light dark`, so a site that follows dark gives one to each surface and text colour it shows (`--card`, `--secondary`, `--muted-foreground`, `--border` above; `--destructive` if it shows errors): a name it leaves keeps the kit's light value. The `dark:` variant, the kit's and the site's own classes' alike once it imports the kit, follows `.dark` on `<html>`, which only the app sets, never a public host: there it never applies, and the tones' and effects' pale badges stay light.
