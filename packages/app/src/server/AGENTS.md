# packages/app/src/server

Server-only code behind the app's server functions.

## Contents

| Path                 | What it is                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`core.ts`](core.ts) | Who is asking and actor checks, the server functions' validators, run detail (with a sandbox run's checks), the runs, the scenarios, start (of a workflow or a scenario) and decide calls, the credentials' statuses, set and clear, Adopt (a drifted field's value at the vendor into its data file, committed through the app's `source`), and what a server function fails with (`serverFnFailure`) |
