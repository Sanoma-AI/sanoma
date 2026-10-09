# connectors/github/test

Tests for the GitHub connector. They run on the recorded replies in `../testdata`, with no token and no network.

## Contents

| Path                                     | What it is                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| [`resources.test.ts`](resources.test.ts) | The generated types parse the recorded reads; the operations, identities and comparison |
| [`driver.test.ts`](driver.test.ts)       | `githubDriver` over a replay: import then read, configuration, errors; `fakeGithub`     |
