# connectors/supabase/test

Tests for the Supabase connector. They run on the replies in `../testdata` and the Management API fixtures in `fixtures/`, with no token and no network.

## Contents

| Path                                       | What it is                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts)   | The generated type parses the replies; flagged fields, operations and their effects, and a declaration without identity, its password a secret                                                                                                                       |
| [`driver.test.ts`](driver.test.ts)         | `supabaseDriver` over a `stateBridge`: import, read by import, a missing project as gone, configuration with a pasted token's or an OAuth grant's token, a call without a connection refused (never the environment), errors; `fakeSupabase`, a project's whole life |
| [`management.test.ts`](management.test.ts) | The Management API operations over `fixtures/` (msw replay), the URL in the secrets store only; a create (and its guard) and delete over the `sanoma-apply-test*` replies                                                                                            |
| [`oauth.test.ts`](oauth.test.ts)           | The `oauth` method end to end over a fake Management API (msw): consent, the callback, the exchange with PKCE and the client's Basic credentials, the organization as the account, and `organization.list` with the stored grant                                     |
| [`replay.ts`](replay.ts)                   | The replay options: token, the project read live (`SUPABASE_TEST_PROJECT_REF`), and the scrub of its ref and organization                                                                                                                                            |
| `fixtures/`                                | Management API exchanges, written by hand in the recorder's format: `pooler`, `health`, `projects` (the guard) and failures                                                                                                                                          |

`vault.test.ts` checks the isolated SQL transport and safe errors. `vault-live.test.ts` is opt-in with `SANOMA_VAULT_TEST_DATABASE_URL`: it creates/drops its own database and login on a disposable administrator instance with the actual Vault extension. It verifies conformance, permissions, CAS, external ownership and rotation; use only synthetic values.
