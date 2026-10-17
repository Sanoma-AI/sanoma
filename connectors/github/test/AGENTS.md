# connectors/github/test

Tests for the GitHub connector. They run on the replies recorded in `@sanoma-ai/bridge`'s `testdata` and GitHub's GraphQL replies in `fixtures/`, with no token and no network.

## Contents

| Path                                     | What it is                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts) | The generated types parse the recorded reads; the operations, identities and comparison                                                                                                                               |
| [`driver.test.ts`](driver.test.ts)       | `githubDriver` over a `stateBridge`: import, read, configuration (a new token, the owner, concurrent calls, a forgotten provider), errors, `gone`, the default bridge and the declared variables; `fakeGithub`        |
| [`node.test.ts`](node.test.ts)           | A node id (a binding id) given to `import`: resolved by one GraphQL query, replayed from `fixtures/` (`@sanoma-ai/testing/replay`; hand-written in the recorded shape until recorded live), and by the fake with none |
