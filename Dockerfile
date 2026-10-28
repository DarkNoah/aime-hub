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

# Shared by the build and runtime images, including Playwright's apt subprocesses.
FROM base AS system-deps
ARG DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG TARGETARCH
# slim has no CA bundle yet. Bootstrap HTTPS with Node's bundled trusted roots;
# the ca-certificates package below replaces it with Debian's managed bundle.
RUN node -e "const fs = require('node:fs'); const path = '/etc/ssl/certs/ca-certificates.crt'; if (!fs.existsSync(path)) { fs.mkdirSync('/etc/ssl/certs', { recursive: true }); fs.writeFileSync(path, require('node:tls').rootCertificates.join('\n') + '\n'); }" \
    && sed -i \
        -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR%/}|g" \
        -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR%/}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
        'Acquire::Retries "3";' \
        'Acquire::http::Timeout "30";' \
        'Acquire::https::Timeout "30";' \
        'Acquire::http::Pipeline-Depth "0";' \
        'APT::Update::Error-Mode "any";' \
        'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
        > /etc/apt/apt.conf.d/99build-network \
    && rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=hub-apt-bookworm-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=hub-apt-lists-bookworm-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 build-essential ffmpeg
# ffmpeg-static honors this path during both installation and runtime. Keep it
# available before pnpm fetch so its install script never downloads from GitHub.
ENV FFMPEG_BIN=/usr/bin/ffmpeg

FROM system-deps AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=hub-pnpm-store,target=/pnpm/store \
    NODE_OPTIONS=--max-old-space-size=1536 nice -n 10 pnpm --store-dir=/pnpm/store --network-concurrency=4 --child-concurrency=1 fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=hub-pnpm-store,target=/pnpm/store \
    NODE_OPTIONS=--max-old-space-size=1536 nice -n 10 pnpm --store-dir=/pnpm/store --child-concurrency=1 install --offline --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=2048 nice -n 10 pnpm build

# Export only the installed, lockfile-resolved CLI. Application source changes
# must not invalidate Chromium's system dependencies and browser download layers.
FROM build AS playwright-package
RUN mkdir -p /opt/playwright-core \
    && cp -aL apps/server/node_modules/playwright-core/. /opt/playwright-core/

FROM system-deps AS server
ARG AGENTFS_VERSION=0.6.4
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    WORKSPACE_ROOT=/data/workspaces
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN --mount=type=cache,id=hub-apt-bookworm-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=hub-apt-lists-bookworm-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        curl xz-utils fuse3 git ripgrep \
        python3-pip python3-venv python-is-python3 \
        jq unzip zip procps openssh-client \
    && python3 -m venv /opt/python \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx
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
COPY --from=playwright-package /opt/playwright-core /opt/playwright-core
RUN --mount=type=cache,id=hub-apt-bookworm-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=hub-apt-lists-bookworm-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    node /opt/playwright-core/cli.js install-deps chromium
COPY --from=browser-cache /opt/playwright /opt/playwright
RUN node /opt/playwright-core/cli.js install chromium
# Keep index selection close to Python dependencies so changing it preserves
# the Node, system-package and browser layers. Runtime pip inherits it as well.
ARG PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DEFAULT_TIMEOUT=30 \
    PIP_RETRIES=3 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Isolate build dependencies for legacy source packages such as pytdx.
COPY plugins/vibe-quant/plugin.manifest.json ./plugins/vibe-quant/plugin.manifest.json
COPY plugins/vibe-quant/worker/requirements.txt ./plugins/vibe-quant/worker/requirements.txt
RUN --mount=type=cache,id=hub-pip-bookworm-${TARGETARCH},target=/root/.cache/pip,sharing=locked \
    if node -e "process.exit(require('./plugins/vibe-quant/plugin.manifest.json').enabled === false ? 1 : 0)"; then \
      /opt/python/bin/pip wheel --use-pep517 --wheel-dir /opt/plugin-wheels/vibe-quant -r plugins/vibe-quant/worker/requirements.txt; \
    fi
COPY --from=build /app /app
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
