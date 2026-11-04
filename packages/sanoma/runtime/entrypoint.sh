#!/bin/sh
# Starts the company in the runtime image: checks out SANOMA_SOURCE at SANOMA_REVISION
# (sanoma-checkout), installs it from its lockfile against the image's store, and runs `sanoma
# worker` (the default) or `sanoma serve` (`docker run … sanoma-runtime serve`: the app beside
# the worker, built at start) on SANOMA_APP_HOST and PORT. Neither builds anything for the
# worker: the config and its files load from their TypeScript source.
set -eu

case "${1:-worker}" in
  worker | serve) command="${1:-worker}" ;;
  *)
    echo "usage: sanoma-runtime [worker|serve]" >&2
    exit 2
    ;;
esac
: "${SANOMA_REVISION:?set SANOMA_REVISION to the commit to run}"
dir="${SANOMA_WORKDIR:-$HOME/company}"

sanoma-checkout "$dir" "$SANOMA_REVISION"
cd "$dir"
# Links into the image's global virtual store (no copy); only what it misses, such as a company's
# own extra package, is fetched. Build scripts stay off unless the repo allows them, with no exit
# for unreviewed ones (pnpm_config_strict_dep_builds): a deploy has no one to review them.
pnpm install --frozen-lockfile --prefer-offline
export SANOMA_APP_PORT="${SANOMA_APP_PORT:-$PORT}"
exec pnpm exec sanoma "$command"
