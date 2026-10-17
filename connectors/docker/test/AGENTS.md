# connectors/docker/test

Tests for the Docker connector.

## Contents

| Path                               | What it is                                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`driver.test.ts`](driver.test.ts) | The type (host, write-only fields, a pinned image, no declared revision), `observed`, `dockerHost`; `dockerDriver` over replies recorded against local Docker (`SANOMA_LIVE=1 SANOMA_RECORD=1` re-records them, with `fixtures/inspect.json`); `fakeDocker` |
| [`host.test.ts`](host.test.ts)     | The conformance kit (`@sanoma-ai/testing/host`) against a container on local Docker, through the apply and drift workflows: the runtime image on `fixtures/company/` over git daemon, two databases. Skips without Docker or `SANOMA_BRIDGE_BIN`            |
| `fixtures/company/`                | The company the container runs: the kit's workflows and credential probe, this checkout's packages packed in by the test                                                                                                                                    |
| `fixtures/inspect.json`            | Docker's inspect answers recorded with the driver's replies                                                                                                                                                                                                 |
