ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine
ARG BUN_IMAGE=oven/bun:1

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN npm install --global pnpm@10.12.1

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=hub-pnpm-store,target=/pnpm/store \
    NODE_OPTIONS=--max-old-space-size=1536 nice -n 10 pnpm --store-dir=/pnpm/store --network-concurrency=4 --child-concurrency=1 fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=hub-pnpm-store,target=/pnpm/store \
    NODE_OPTIONS=--max-old-space-size=1536 nice -n 10 pnpm --store-dir=/pnpm/store --child-concurrency=1 install --offline --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 pnpm build

FROM base AS server
ARG AGENTFS_VERSION=0.6.4
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    WORKSPACE_ROOT=/data/workspaces
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils fuse3 git ripgrep ffmpeg \
        python3 python3-pip python3-venv python-is-python3 \
        build-essential jq unzip zip procps openssh-client \
    && python3 -m venv /opt/python \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$(uname -m)" in x86_64) arch=x86_64 ;; aarch64) arch=aarch64 ;; *) exit 1 ;; esac; \
    archive="agentfs-${arch}-unknown-linux-gnu.tar.xz"; \
    base="https://github.com/tursodatabase/agentfs/releases/download/v${AGENTFS_VERSION}"; \
    cd /tmp; \
    curl -fSL --retry 3 "${base}/${archive}" -o "${archive}"; \
    curl -fSL --retry 3 "${base}/${archive}.sha256" -o "${archive}.sha256"; \
    sha256sum -c "${archive}.sha256"; \
    tar -xJf "${archive}"; \
    install "agentfs-${arch}-unknown-linux-gnu/agentfs" /usr/local/bin/agentfs; \
    rm -rf /tmp/agentfs-*
RUN mkdir -p /data/workspaces
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
RUN node apps/server/node_modules/playwright-core/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
ENV PATH="/opt/python/bin:${PATH}"
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "pnpm db:migrate && exec node apps/server/dist/index.js"]

FROM ${NGINX_IMAGE} AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/api/health || exit 1
