# types

Ambient type declarations for the whole repo: web types that the repo's lib (es2024 and Node's types, no DOM) leaves out but generated clients name, and Vite's `?url` imports for the app's tests. The root `tsconfig.json` includes this directory, and so does each connector's build that needs it.

## Contents

| Path                               | What it is                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`asset-url.d.ts`](asset-url.d.ts) | Declares `*?url`, a Vite asset import as its URL, for app tests whose components import marks  |
| [`web.d.ts`](web.d.ts)             | Declares `BodyInit`, what a `fetch` body may be, for the Hey API client in `connectors/resend` |
