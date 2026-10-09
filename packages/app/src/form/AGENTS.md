# packages/app/src/form

The start form: it turns a workflow's input JSON Schema into form fields and renders them. The server still validates the input, so the form only shapes entry.

## Contents

| Path                               | What it is                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`schema.ts`](schema.ts)           | Reads a JSON Schema into field descriptions: scalars, enums, one level of nesting, JSON fallback |
| [`start-form.tsx`](start-form.tsx) | TanStack Form that renders those fields and starts the run                                       |
