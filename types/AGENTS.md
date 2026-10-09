# types

Ambient type declarations for the whole repo: web types that the repo's lib (es2024 and Node's types, no DOM) leaves out but generated clients name. The root `tsconfig.json` includes this directory, and so does each connector's build that needs it.

## Contents

| Path                   | What it is                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| [`web.d.ts`](web.d.ts) | Declares `BodyInit`, what a `fetch` body may be, for the Hey API client in `connectors/resend` |
