ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine
ARG BUN_IMAGE=oven/bun:1
ARG BROWSER_CACHE_IMAGE=base

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN npm install --global pnpm@10.12.1

# An optional image can supply already downloaded Playwright browsers.
# The default is empty; Playwright downloads any missing browser revision.
FROM ${BROWSER_CACHE_IMAGE} AS browser-cache
RUN mkdir -p /opt/playwright

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
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
ARG AGENTFS_DOWNLOAD_BASE_URL=https://github.com/tursodatabase/agentfs/releases/download
RUN set -eu; \
    case "$(uname -m)" in x86_64) arch=x86_64 ;; aarch64) arch=aarch64 ;; *) exit 1 ;; esac; \
    archive="agentfs-${arch}-unknown-linux-gnu.tar.xz"; \
    base="${AGENTFS_DOWNLOAD_BASE_URL%/}/v${AGENTFS_VERSION}"; \
    cd /tmp; \
    curl -fsSL --http1.1 --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 "${base}/${archive}" -o "${archive}"; \
    curl -fsSL --http1.1 --retry 3 --retry-all-errors --connect-timeout 15 --max-time 180 "${base}/${archive}.sha256" -o "${archive}.sha256"; \
    sha256sum -c "${archive}.sha256"; \
    tar -xJf "${archive}"; \
    install "agentfs-${arch}-unknown-linux-gnu/agentfs" /usr/local/bin/agentfs; \
    rm -rf /tmp/agentfs-*
RUN mkdir -p /data/workspaces
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
RUN node apps/server/node_modules/playwright-core/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=browser-cache /opt/playwright /opt/playwright
RUN node apps/server/node_modules/playwright-core/cli.js install chromium
COPY --from=build /app /app
# Isolate build dependencies for legacy source packages such as pytdx.
RUN if node -e "process.exit(require('./plugins/vibe-quant/plugin.manifest.json').enabled === false ? 1 : 0)"; then \
      /opt/python/bin/pip wheel --use-pep517 --no-cache-dir --wheel-dir /opt/plugin-wheels/vibe-quant -r plugins/vibe-quant/worker/requirements.txt; \
    fi
ENV PATH="/opt/python/bin:${PATH}"
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "pnpm db:migrate && exec node apps/server/dist/index.js"]

FROM ${NGINX_IMAGE} AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/api/health || exit 1
