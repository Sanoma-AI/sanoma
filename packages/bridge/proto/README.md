# Bridge protocol provenance

`bridge/v1/bridge.proto` is copied verbatim from [Sanoma-AI/provider-bridge](https://github.com/Sanoma-AI/provider-bridge/blob/main/proto/bridge/v1/bridge.proto). The session-protocol-1 source is commit `f1da64818663e017fba4dcd0b89d808df6afd20b` on the coordinated B1 branch (provider-bridge issue #11). Its matching release and consumer archive pins are pending.

This revision adds operation UUID sessions, process-bound plan tokens and `GetSchema.session_protocol` negotiation. Regenerate TypeScript with the pinned tools using `pnpm --filter @sanoma-ai/bridge run generate`; do not edit generated files. Release the matching Go binary and update Sanoma’s binary/archive pins before shipping this client. See [Develop](../README.md#develop).
