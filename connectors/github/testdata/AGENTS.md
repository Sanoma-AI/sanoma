# connectors/github/testdata

Fixtures copied unchanged from [provider-bridge](https://github.com/Sanoma-AI/provider-bridge)'s `testdata` at a2fc11a, where its README says how they were recorded and scrubbed. Not formatted by oxfmt, so they stay byte for byte as recorded.

## Contents

| Path                                                         | What it is                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`replies/integrations_github_6.13.0/`](replies/)            | Recorded import and read replies, which the fake serves. Shipped in the package              |

The replies: `github_repository` `sanoma` and `provider-bridge` (import and read), and `github_branch_protection` `provider-bridge:main` (import only: it failed, the branch being unprotected). No team membership was recorded: the organization has no teams.
