# connectors/supabase/test

Tests for the Supabase connector. They run on the replies in `../testdata` and the Management API fixtures in `fixtures/`, with no token and no network.

## Contents

| Path                                       | What it is                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts)   | The generated type parses the replies; flagged fields, operations and their effects, and a declaration without identity, its password a secret                                    |
| [`driver.test.ts`](driver.test.ts)         | `supabaseDriver` over a `stateBridge`: import, read by import, a missing project as gone, configuration, errors and the declared variable; `fakeSupabase`, a project's whole life |
| [`management.test.ts`](management.test.ts) | The Management API operations over `fixtures/` (msw replay), the URL in the secrets store only; a create (and its guard) and delete over the `sanoma-apply-test*` replies         |
| [`replay.ts`](replay.ts)                   | The replay options: token, the project read live (`SUPABASE_TEST_PROJECT_REF`), and the scrub of its ref and organization                                                         |
| `fixtures/`                                | Management API exchanges, written by hand in the recorder's format: `pooler`, `health`, `projects` (the guard) and failures                                                       |
