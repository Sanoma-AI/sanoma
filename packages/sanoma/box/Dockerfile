# The box image: the computer a person's coding agents work in, which the Agent37 connector makes
# a box from by default (ghcr.io/sanoma-ai/box, tagged with the sanoma version, registered as a
# template of the company's workspace). Node 26, git, pnpm, and every connector's own coding agent
# (`agents.json`, which a test holds to what the connectors declare) installed under
# /opt/sanoma/agents/<id>, as the app installs one in a box's home, so a first turn waits for no
# install. Nothing lives under /home/node: Agent37 mounts the box's persistent volume there, which
# masks what the image holds.
#
#   docker build --platform linux/amd64 -t sanoma-box packages/sanoma/box

FROM node:26-bookworm-slim
# The pnpm the agents' installs and a clone's install run: the repository's own `packageManager`.
ARG PNPM_VERSION=11.28.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@$PNPM_VERSION" && npm cache clean --force
# The agents, owned by root: `node` reads and runs them, and writes nothing in them. pnpm's store
# and cache go once they are installed (the installs' files are hard links into the store), and so
# does what a `setup` left in /tmp, root's, which `node` could not write to (OpenCode's /tmp/opencode).
RUN --mount=type=bind,source=agents.json,target=/mnt/box/agents.json \
    --mount=type=bind,source=install-agents.mjs,target=/mnt/box/install-agents.mjs \
    pnpm_config_store_dir=/tmp/pnpm-store node /mnt/box/install-agents.mjs /mnt/box/agents.json /opt/sanoma/agents \
 && rm -rf /tmp/* "$HOME/.cache" "$HOME/.local" "$HOME/.config"
USER node
WORKDIR /home/node
# Agent37 keeps an instance up while its main process runs; Sanoma's runner is started in it by exec.
CMD ["sleep", "infinity"]
