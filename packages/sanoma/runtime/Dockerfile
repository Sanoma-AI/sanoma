# syntax=docker/dockerfile:1
#
# The Sanoma runtime: Node, git, an SSH client, pnpm and provider-bridge, and no company code. At
# start, entrypoint.sh clones the company's repository (SANOMA_SOURCE) at a commit
# (SANOMA_REVISION), with its deploy key (SANOMA_SOURCE_KEY) when set, installs it and runs
# `sanoma serve` on PORT. A host passes those, and the two bootstrap secrets, SANOMA_DATABASE_URL
# and SANOMA_SECRETS_KEY, as environment variables.
#
#   docker build -t sanoma-runtime packages/sanoma/runtime
#
# The bridge release matches @sanoma-ai/bridge's isolated-session protocol. Source builds
# remain available with --build-arg BRIDGE_FROM=source at the same release's commit.

ARG BRIDGE_FROM=release
ARG BRIDGE_COMMIT=0f6659a8931ae9b565acc1ada621d981e944a066
ARG BRIDGE_VERSION=0.2.0

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
 && curl -fsSLO "$base/$archive" \
 && case "$TARGETARCH" in \
      amd64) checksum=3a4161434bb20e1516938616084c40c78e4c657e75f791cd10cba8a6e8f67e0c ;; \
      arm64) checksum=1d62ea033fa197d87baf10010445b275591575fec5c8aa049c48b20f014ffc47 ;; \
      *) echo "Unsupported bridge architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && echo "$checksum  $archive" | sha256sum -c - \
 && mkdir /out && tar -xzf "$archive" -C /out provider-bridge

FROM bridge-${BRIDGE_FROM} AS bridge

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11 && npm cache clean --force
COPY --from=bridge /out/provider-bridge /usr/local/bin/provider-bridge
# Exercise the actual image binary before CI or a release can ship it. The check's downloaded
# provider and cache are temporary; no company configuration or credentials are involved.
RUN --mount=type=bind,source=check-bridge.mjs,target=/tmp/check-bridge.mjs \
    node /tmp/check-bridge.mjs /usr/local/bin/provider-bridge
# GitHub's SSH host keys, read at start, and the copy committed beside it for when GitHub's API cannot answer.
COPY github-known-hosts.mjs github_known_hosts /usr/local/share/sanoma/
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
