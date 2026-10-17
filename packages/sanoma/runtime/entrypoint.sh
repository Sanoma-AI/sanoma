#!/bin/sh
# Starts the company in the runtime image: clones SANOMA_SOURCE at SANOMA_REVISION (signed in
# with SANOMA_SOURCE_TOKEN when set), installs it from its lockfile and runs `sanoma serve` on
# SANOMA_APP_HOST (0.0.0.0, so the host passes the SANOMA_GITHUB_* sign-in variables) and PORT.
set -eu

: "${SANOMA_SOURCE:?set SANOMA_SOURCE to the clone URL of the company repository}"
: "${SANOMA_REVISION:?set SANOMA_REVISION to the commit to run}"
dir="${SANOMA_WORKDIR:-$HOME/company}"

# The token goes in a header for these commands only, never into the URL or .git/config.
auth=""
if [ -n "${SANOMA_SOURCE_TOKEN:-}" ]; then
  auth="http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$SANOMA_SOURCE_TOKEN" | base64 | tr -d '\n')"
fi
git_() {
  if [ -n "$auth" ]; then git -c "$auth" -C "$dir" "$@"; else git -C "$dir" "$@"; fi
}

rm -rf "$dir"
git init -q "$dir"
git -C "$dir" remote add origin "$SANOMA_SOURCE"
# One commit when the server allows fetching it by id (GitHub does), else the whole history.
git_ fetch -q --depth 1 origin "$SANOMA_REVISION" || git_ fetch -q --tags origin
git -C "$dir" checkout -q --detach "$SANOMA_REVISION"

cd "$dir"
pnpm install --frozen-lockfile
export SANOMA_APP_PORT="${SANOMA_APP_PORT:-$PORT}"
exec pnpm exec sanoma serve
