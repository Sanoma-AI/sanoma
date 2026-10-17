# connectors/supabase/testdata

Replies in the recorder's format, written by hand to the provider's schema (`@sanoma-ai/bridge`'s `testdata/schemas/supabase_supabase_1.11.0.json`) and its source (`internal/provider/project_resource.go` at v1.11.0). Not formatted by oxfmt.

## Contents

| Path                                           | What it is                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`replies/supabase_supabase_1.11.0/`](replies/) | Import and read replies for a project, and the import of a missing one, which the fake serves |

The replies are not recorded: no Supabase access token was on the recording machine. Each file says so in its `synthetic` field. They follow the schema's implied type (every attribute present, `null` when unset, `database_password` always `null`) with made-up values, refs `sanomatestprojectref` and `sanomamissingproject`. The missing one is the provider's answer to a 404, the import's state with nothing but its `id`. Re-record them with provider-bridge's `bridge-record` and a token, and copy them here.
