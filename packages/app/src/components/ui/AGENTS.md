# packages/app/src/components/ui

shadcn/ui components, added by the shadcn CLI as configured in [`components.json`](../../../components.json) (`radix-nova` style, on Radix primitives), one file per component. They are the app's base controls, all stock shadcn components; the app's own components in the parent directory compose them.

`resizable.tsx` wraps [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) v4; give the group a `defaultLayout` keyed by each panel's `id` so the server renders the same sizes, and never persist a layout in storage.
