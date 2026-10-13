# packages/app/src/server

Server-only code behind the app's server functions.

## Contents

| Path                 | What it is                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`core.ts`](core.ts) | Who is asking and actor checks, input parsing, run detail (with a sandbox run's checks), the scenarios, start (of a workflow or a scenario) and decide calls, the credentials' statuses, set and clear, and errors as `ApiError`s |
