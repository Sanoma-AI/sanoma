# Invoice editor

Public through `sanoma/ui`; behavior and props are in the [app README](../../../README.md#stateless-invoice-editor).

- `index.tsx`: TanStack Form fields, local PNG intake, actual PDF preview and download ownership.
- `draft.ts`: editable strings and industry form mapping into shared invoice validation; no calculation rules here.
- `preview.ts`: debounced, revision-aware rendering with in-flight reuse; imports the browser PDF engine lazily.

Keep this module graph free of app APIs, runtime, persistence and document network requests. Maintain the source scan in `src/ui.css` and the explicit export/module-graph test in `test/ui.test.ts`. Test draft/preview behavior with `test/invoice-editor.test.ts` and the real browser smoke described in the README. Industry differences belong in the shared adapters, not copied editors.
