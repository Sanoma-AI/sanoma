# connectors/ghost/test

Tests for the Ghost driver, run against recorded Ghost replies instead of a live site.

## Contents

| Path                               | What it is                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)           | Recorded Ghost exchanges the tests replay                                         |
| [`driver.test.ts`](driver.test.ts) | `ghostDriver`: creating and publishing posts, update collisions and error mapping |
