FROM node:24-slim

# git is required by the workspace (clone, checkpoint commits, salvage push).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI for `runner: claude-code`. No Codex CLI, no Python.
RUN npm install -g @anthropic-ai/claude-code \
    && corepack enable

# Claude Code refuses --dangerously-skip-permissions when running as root.
# (The base image already owns uid 1000 as `node`, so let useradd pick the uid.)
RUN useradd -m hive
USER hive
WORKDIR /home/hive/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NODE_ENV=production

# Dependencies first so the layer is cached until the lockfile changes.
COPY --chown=hive:hive package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY --chown=hive:hive tsconfig.json ./
COPY --chown=hive:hive src ./src
COPY --chown=hive:hive agents ./agents
RUN pnpm build && pnpm prune --prod

EXPOSE 8000

# PORT defaults to 8000 in the receiver; set explicitly so the image and EXPOSE agree.
ENV PORT=8000
CMD ["node", "dist/webhook/main.js"]
