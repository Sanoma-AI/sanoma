# packages/app/src/form

The start form: it turns a workflow's input JSON Schema into form fields and renders them, empty for a live run or filled read-only with a scenario's input for a sandbox run. The server still validates the input, so the form only shapes entry.

## Contents

| Path                               | What it is                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`schema.ts`](schema.ts)           | Reads a JSON Schema into field descriptions: scalars, enums, one level of nesting, JSON fallback; the form's starting values, from defaults or a given input (`initialValues`), date-times as ISO text, and the input it sends                  |
| [`start-form.tsx`](start-form.tsx) | TanStack Form that renders those fields (a date-time, `DateTimeInput`, as ISO text on the server, then in the browser's time zone) and starts the run, or with a scenario shows its input in a disabled fieldset and starts a sandbox run of it |
