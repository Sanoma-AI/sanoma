# connectors/supabase/test

Tests for the Supabase connector. They run on the replies in `../testdata`, with no token and no network.

## Contents

| Path                                     | What it is                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts) | The generated type parses the replies; flagged fields, operations, and a declaration without identity, its password a secret                              |
| [`driver.test.ts`](driver.test.ts)       | `supabaseDriver` over a `stateBridge`: import, read by import, a missing project as gone, configuration, errors and the declared variable; `fakeSupabase` |
