# connectors/github/test

Tests for the GitHub connector. They run on the replies recorded in `@sanoma-ai/bridge`'s `testdata`, with no token and no network.

## Contents

| Path                                     | What it is                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts) | The generated types parse the recorded reads; the operations, identities and comparison                                                                                                                        |
| [`driver.test.ts`](driver.test.ts)       | `githubDriver` over a `stateBridge`: import, read, configuration (a new token, the owner, concurrent calls, a forgotten provider), errors, `gone`, the default bridge and the declared variables; `fakeGithub` |
