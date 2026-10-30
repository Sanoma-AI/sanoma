# Bridge protocol provenance

`bridge/v1/bridge.proto` is copied verbatim from [Sanoma-AI/provider-bridge commit `0f6659a8931ae9b565acc1ada621d981e944a066`](https://github.com/Sanoma-AI/provider-bridge/blob/0f6659a8931ae9b565acc1ada621d981e944a066/proto/bridge/v1/bridge.proto), released as [v0.2.0](https://github.com/Sanoma-AI/provider-bridge/releases/tag/v0.2.0). Sanoma’s `scripts/download-bridge.ts` pins v0.2.0 and the four archive checksums from that release’s `SHA256SUMS`.

This revision adds operation UUID sessions, process-bound plan tokens and `GetSchema.session_protocol` negotiation. Regenerate TypeScript with the pinned tools using `pnpm --filter @sanoma-ai/bridge run generate`; do not edit generated files. The Go release and consumer binary pins are available; publication of the updated Sanoma client and platform packages to npm remains pending. See [Develop](../README.md#develop).
