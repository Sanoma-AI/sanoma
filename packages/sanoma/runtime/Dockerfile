# syntax=docker/dockerfile:1
#
# The Sanoma runtime: Node, git, pnpm and provider-bridge, and no company code. At start,
# entrypoint.sh clones the company's repository (SANOMA_SOURCE) at a commit (SANOMA_REVISION),
# installs it and runs `sanoma serve` on PORT. A host passes those, and the two bootstrap
# secrets, SANOMA_DATABASE_URL and SANOMA_SECRETS_KEY, as environment variables.
#
#   docker build -t sanoma-runtime packages/sanoma/runtime
#
# provider-bridge is built from source at BRIDGE_COMMIT until it publishes releases; then
# `--build-arg BRIDGE_FROM=release --build-arg BRIDGE_VERSION=0.1.0` downloads the release
# archive instead, checked against the release's SHA256SUMS.

ARG BRIDGE_FROM=source
ARG BRIDGE_COMMIT=0ae215dccaa6d175bc14d3685c67fcb8c74d7233
ARG BRIDGE_VERSION=""

FROM golang:1.26-bookworm AS bridge-source
ARG BRIDGE_COMMIT
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/Sanoma-AI/provider-bridge "$BRIDGE_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags="-s -w" -o /out/provider-bridge ./cmd/provider-bridge

FROM debian:bookworm-slim AS bridge-release
ARG BRIDGE_VERSION
ARG TARGETOS
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN test -n "$BRIDGE_VERSION" || { echo "BRIDGE_FROM=release needs BRIDGE_VERSION" >&2; exit 1; } \
 && archive="provider-bridge_${BRIDGE_VERSION}_${TARGETOS}_${TARGETARCH}.tar.gz" \
 && base="https://github.com/Sanoma-AI/provider-bridge/releases/download/v${BRIDGE_VERSION}" \
 && curl -fsSLO "$base/$archive" && curl -fsSLO "$base/SHA256SUMS" \
 && grep " $archive\$" SHA256SUMS | sha256sum -c - \
 && mkdir /out && tar -xzf "$archive" -C /out provider-bridge

FROM bridge-${BRIDGE_FROM} AS bridge

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11 && npm cache clean --force
COPY --from=bridge /out/provider-bridge /usr/local/bin/provider-bridge
COPY --chmod=755 entrypoint.sh /usr/local/bin/sanoma-runtime
ENV SANOMA_BRIDGE_BIN=/usr/local/bin/provider-bridge \
    SANOMA_APP_HOST=0.0.0.0 \
    PORT=3000
USER node
WORKDIR /home/node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=300s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/sanoma-runtime"]
