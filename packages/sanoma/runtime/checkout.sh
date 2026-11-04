#!/bin/sh
# sanoma-checkout <dir> <revision>: SANOMA_SOURCE at one commit in <dir>, a fresh shallow checkout
# (what was there is removed), signed in with SANOMA_SOURCE_KEY or SANOMA_SOURCE_TOKEN when set.
# The entrypoint checks out the company with it; the worker checks out a revision it builds the
# app bundle for (SANOMA_CHECKOUT names this script).
set -eu
# No prompt: a fetch that would ask for a password fails instead, so a bad credential is an exit, not a hang.
export GIT_TERMINAL_PROMPT=0

: "${SANOMA_SOURCE:?set SANOMA_SOURCE to the clone URL of the company repository}"
dir="${1:?usage: sanoma-checkout <dir> <revision>}"
revision="${2:?usage: sanoma-checkout <dir> <revision>}"

# SANOMA_SOURCE_KEY, a read-only deploy key's private half (what going live gives a host): the
# fetch goes to GitHub over SSH with it, on the HTTPS port (ssh.github.com:443, which egress
# allows where 22 may not be), trusting only GitHub's host keys, its own list (api.github.com/meta,
# over HTTPS), else the image's copy of it. SANOMA_SOURCE_TOKEN, a token, goes in a header
# instead. Either is for these commands only, never in .git/config, whose origin stays
# SANOMA_SOURCE; the key's file is gone when this script ends.
if [ -n "${SANOMA_SOURCE_KEY:-}" ]; then
  case "$SANOMA_SOURCE" in
    https://github.com/*) ;;
    *)
      echo "SANOMA_SOURCE_KEY is a GitHub deploy key: set SANOMA_SOURCE to https://github.com/<owner>/<name>.git" >&2
      exit 1
      ;;
  esac
  keys="$(mktemp -d)"
  trap 'rm -rf "$keys"' EXIT
  (umask 077 && printf '%s\n' "$SANOMA_SOURCE_KEY" > "$keys/key")
  if ! node /usr/local/share/sanoma/github-known-hosts.mjs > "$keys/known_hosts"; then
    echo "sanoma-checkout: api.github.com did not list GitHub's host keys: trusting the image's copy" >&2
    cp /usr/local/share/sanoma/github_known_hosts "$keys/known_hosts"
  fi
  ssh="ssh -F /dev/null -i $keys/key -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$keys/known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes"
  git_() { git -c "url.ssh://git@ssh.github.com:443/.insteadOf=https://github.com/" -c "core.sshCommand=$ssh" -C "$dir" "$@"; }
elif [ -n "${SANOMA_SOURCE_TOKEN:-}" ]; then
  auth="http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$SANOMA_SOURCE_TOKEN" | base64 | tr -d '\n')"
  git_() { git -c "$auth" -C "$dir" "$@"; }
else
  git_() { git -C "$dir" "$@"; }
fi

rm -rf "$dir"
git init -q "$dir"
git -C "$dir" remote add origin "$SANOMA_SOURCE"
# One commit when the server allows fetching it by id (GitHub does), else the whole history.
git_ fetch -q --depth 1 origin "$revision" || git_ fetch -q --tags origin
git -C "$dir" checkout -q --detach "$revision"
