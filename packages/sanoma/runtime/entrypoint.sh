#!/bin/sh
# Starts the company in the runtime image: checks out SANOMA_SOURCE at SANOMA_REVISION and
# installs it from its lockfile against the image's store (sanoma-checkout), and runs `sanoma
# worker` (the default) or `sanoma serve` (`docker run … sanoma-runtime serve`: the app beside
# the worker, built at start) on SANOMA_APP_HOST and PORT. Neither builds anything for the
# worker: the config and its files load from their TypeScript source. `identity` runs no
# company: the release's `sanoma identity`, from the identity service's host configuration
# (SANOMA_IDENTITY_MODE and its database URLs; see CLOUD-IDENTITY.md).
set -eu

case "${1:-worker}" in
  worker | serve) command="${1:-worker}" ;;
  identity)
    shift
    exec /pnpm/template/node_modules/.bin/sanoma identity "$@"
    ;;
  *)
    echo "usage: sanoma-runtime [worker|serve|identity]" >&2
    exit 2
    ;;
esac
: "${SANOMA_REVISION:?set SANOMA_REVISION to the commit to run}"
dir="${SANOMA_WORKDIR:-$HOME/company}"

sanoma-checkout "$dir" "$SANOMA_REVISION"
cd "$dir"
export SANOMA_APP_PORT="${SANOMA_APP_PORT:-$PORT}"
exec pnpm exec sanoma "$command"
