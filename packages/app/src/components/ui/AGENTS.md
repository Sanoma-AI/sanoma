# packages/app/src/components/ui

shadcn/ui components, added by the shadcn CLI as configured in [`components.json`](../../../components.json) (`base-nova` style, on Base UI primitives: a part takes `render`, not `asChild`), one file per component. They are the app's base controls, stock shadcn components but one: `slider.tsx` also passes `getAriaLabel` to each thumb, so a Slider with one thumb can be named. The app's own components in the parent directory compose them.
