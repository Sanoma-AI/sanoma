# syntax=docker/dockerfile:1
#
# The Sanoma runtime: Node, git, an SSH client, pnpm, provider-bridge and a pnpm store of this
# release's packages, and no company code. At start, entrypoint.sh checks the company's
# repository (SANOMA_SOURCE) out at a commit (SANOMA_REVISION), with its deploy key
# (SANOMA_SOURCE_KEY) when set, installs it against the store and runs `sanoma worker` on PORT
# (`/healthz`, `/wake`, the app bundle), or with the command `serve`, `sanoma serve`. A host passes
# those, and the bootstrap secrets (SANOMA_DATABASE_URL, SANOMA_SECRETS_KEY, SANOMA_WAKEUP_TOKEN),
# as environment variables. With the command `identity` it checks nothing out and runs this
# release's `sanoma identity` from the identity service's own settings (SANOMA_IDENTITY_*).
#
#   docker build --build-arg PACKAGES="$(node scripts/runtime-packages.ts)" -t sanoma-runtime packages/sanoma/runtime
#
# A cold start, measured locally at half a CPU and 4 GiB (2026-11-04; the pull not included): the
# checkout under a second, the install 7-10 s for a lockfile the store matches and 14-30 s for one
# a `pnpm update --latest` behind, the worker's /healthz 6-16 s after.
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
# The pnpm every company installs with: the repository's own `packageManager`, whatever a company's
# names (pnpm_config_pm_on_fail=ignore, so pnpm never downloads another).
ARG PNPM_VERSION=11.28.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@$PNPM_VERSION" && npm cache clean --force
COPY --from=bridge /out/provider-bridge /usr/local/bin/provider-bridge
# Exercise the actual image binary before CI or a release can ship it. The check's downloaded
# provider and cache are temporary; no company configuration or credentials are involved.
RUN --mount=type=bind,source=check-bridge.mjs,target=/tmp/check-bridge.mjs \
    node /tmp/check-bridge.mjs /usr/local/bin/provider-bridge
# A company's install links into a global virtual store (`<store>/links`): node_modules is
# symlinks, so what the store has is not copied. These settings win over a company's own.
ENV pnpm_config_store_dir=/pnpm/store \
    pnpm_config_enable_global_virtual_store=true \
    pnpm_config_pm_on_fail=ignore \
    pnpm_config_strict_dep_builds=false
RUN mkdir /pnpm && chown node:node /pnpm
USER node
# The store, from a template project of this release (`node scripts/runtime-packages.ts`: from npm,
# which the release fills before it builds the image), resolved as a company's is. The project stays:
# its node_modules is symlinks into the store, and its `sanoma` is what the command `identity` runs.
ARG PACKAGES=sanoma
RUN mkdir /pnpm/template && cd /pnpm/template && echo '{"private":true}' > package.json \
 && printf 'minimumReleaseAgeExclude:\n  - sanoma\n  - "@sanoma-ai/*"\n' > pnpm-workspace.yaml \
 && pnpm add $PACKAGES \
 && rm -rf "$HOME/.cache/pnpm"
# At start: a package whose dependencies differ from the template's is copied out of the store,
# faster than a hard link into a lower layer, which overlayfs copies up anyway; and the lockfile
# is trusted, its release ages checked when the company resolved it, not again per entry online.
ENV pnpm_config_package_import_method=copy \
    pnpm_config_trust_lockfile=true
# GitHub's SSH host keys, read at start, and the copy committed beside it for when GitHub's API cannot answer.
COPY github-known-hosts.mjs github_known_hosts /usr/local/share/sanoma/
COPY --chmod=755 checkout.sh /usr/local/bin/sanoma-checkout
COPY --chmod=755 entrypoint.sh /usr/local/bin/sanoma-runtime
ENV SANOMA_BRIDGE_BIN=/usr/local/bin/provider-bridge \
    SANOMA_CHECKOUT=/usr/local/bin/sanoma-checkout \
    SANOMA_APP_HOST=0.0.0.0 \
    PORT=3000
WORKDIR /home/node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=10s --start-period=300s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/sanoma-runtime"]
CMD ["worker"]
