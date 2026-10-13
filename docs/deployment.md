# Dokploy 部署

仓库使用多阶段 `Dockerfile` 和 `compose.yaml`：`web` 用 Nginx 提供前端并代理 `/api`，`server` 运行 API，`postgres` 使用独立 PostgreSQL 数据库。前端与 API 共用 HTTPS 域名，代理关闭 SSE 缓冲。

## 运行环境

服务容器包含 Node.js 22、npm、pnpm 10.12.1、Bun 1、Python 3（含 pip、venv）、FFmpeg、Git、curl、jq、zip/unzip、ripgrep、编译工具、Chromium 和 AgentFS 0.6.4。Python 默认使用 `/opt/python` 虚拟环境，可以直接执行 `python`、`pip`。

项目共享工作区需要 Linux FUSE，因此仅 `server` 配置 `/dev/fuse`、`SYS_ADMIN` 和 `apparmor:unconfined`，宿主机须提供 `/dev/fuse`。不要运行多个 API 副本：队列、调度器和工作区挂载由单个进程管理。

浏览器下载缓慢时，可将一个已验证且包含 `/opt/playwright` 的同架构镜像预载到服务器，并设置 `BROWSER_CACHE_IMAGE` 为该镜像。构建只从中复制浏览器目录；系统依赖仍由 Playwright 检查安装，应用代码仍从 Git 构建。所需浏览器版本不在缓存中时会正常下载。默认无需设置此变量。缓存镜像必须对实际构建器可用；本地镜像被清理后，构建器可能尝试从 Docker Hub 拉取同名镜像并失败。此时删除该变量或设置为 `base`，恢复正常浏览器下载。

服务器无法访问 GitHub Releases 时，可通过 `AGENTFS_DOWNLOAD_BASE_URL` 指定可信的 AgentFS 下载源，默认值为 `https://github.com/tursodatabase/agentfs/releases/download`。例如，配置 `https://githubproxy.cc/https://github.com/tursodatabase/agentfs/releases/download` 使用代理通道。构建会追加 `/v<版本号>/<架构对应文件名>`，下载发行包和 `.sha256` 文件并校验。使用备用源前应将其校验值与官方发布的校验值核对。

## Dokploy 配置

1. 创建 Docker Compose 服务，来源选择 **Git**，仓库为 `https://github.com/DarkNoah/aime-hub.git`，分支为 `main`，Compose 路径为 `./compose.yaml`。
2. 配置以下环境变量。密钥只保存在 Dokploy，不能提交到 Git：

   ```dotenv
   WEB_ORIGINS=https://your-domain.example
   POSTGRES_PASSWORD=<随机字母数字密码，用于数据库连接 URL>
   BETTER_AUTH_SECRET=<至少 32 字符的随机密钥>
   ADMINS=admin
   TZ=Asia/Shanghai
   ```

   可选配置 `WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY`、`WEB_PUSH_SUBJECT`。镜像仓库受限时可通过 `NODE_IMAGE`、`NGINX_IMAGE`、`BUN_IMAGE`、`POSTGRES_IMAGE` 指定可用镜像源。

   `WEB_ORIGINS` 必填且不能为空；多个完整来源用逗号分隔，第一项是默认入口及无请求上下文时的认证地址。升级旧配置时，将原 `WEB_ORIGIN` 放在列表第一项，合并额外来源，再删除 `WEB_ORIGIN` 和 `BETTER_AUTH_URL`。生产环境默认要求所有来源使用 HTTPS。

3. 在 Domains 中将域名路由至 `web:80`，启用 HTTPS。域名必须指向入口服务器，并允许证书验证流量到达入口。
4. 部署。服务启动前执行幂等数据库迁移；API 健康后才启动 Web。
5. 在 `server` 容器终端运行 `pnpm auth:create-admin`，交互输入管理员邮箱、用户名和密码。没有默认管理员密码。

`postgres-data` 和 `workspace-data` 使用命名卷，重新部署保留数据。不要启用 Fresh Volumes 或执行 `docker compose down -v`，除非有意清空数据。备份应同时覆盖 PostgreSQL 与工作区卷。模型供应商在新数据库中需由管理员重新配置。

## 认证代理与多入口

Better Auth 根据配置列表构建动态 `baseURL`，认证链接使用请求的主机、端口和协议，缺少或未匹配主机时回退到第一项；来源和回调地址仍按完整白名单校验。Nginx 使用 `$http_host` 保留非默认端口，并覆盖 `X-Forwarded-Host`。HTTPS 入口代理必须覆盖 `X-Forwarded-Proto` 为真实的外部协议；Nginx 在没有有效转发协议时使用自身协议，因此直接内网 HTTP 访问也可工作。API 只通过受控代理暴露，不应直接发布后端端口。

HTTPS-only 配置使用 Secure Cookie；显式包含 HTTP 来源时使用可在 HTTP 上传输的 Cookie，生产环境还需 `ALLOW_INSECURE_HTTP=true`。不同主机不共享 Cookie，需要分别登录。前端静态镜像构建不需要注入这些运行时来源；更新来源后重启 API 和开发服务。

## Git 自动更新

### 暂时通过内网 IP 访问

设置 `WEB_ORIGINS=http://服务器IP:8088`、`ALLOW_INSECURE_HTTP=true`；其他需要访问的完整 HTTP 来源按逗号追加，第一项作为默认入口。在 Dokploy 的 Compose Command 中使用 `compose -p <实际appName> --env-file .env -f ./compose.yaml -f ./compose.ip.yaml up -d --build --remove-orphans`。`WEB_PORT` 默认 8088，`WEB_BIND_IP` 默认 0.0.0.0。HTTP 模式限可信内网，浏览器 Web Push 不可用；切换域名 HTTPS 时去掉覆盖文件并恢复 `ALLOW_INSECURE_HTTP=false`。

### 公网 Webhook

在 Dokploy 开启 Auto Deploy，并将 Deployments 页面提供的 Webhook URL 加入 GitHub 仓库的 Webhooks，事件选择 `push`、内容类型选择 `application/json`。GitHub 必须能访问该 URL；仅内网地址无法接收 GitHub 回调。推送 `main` 后，Dokploy 重新拉取代码、构建 Dockerfile、执行迁移并更新容器。

检查 GitHub webhook delivery 与 Dokploy 部署记录，确认自动部署成功，而不只是打开开关。数据库迁移不自动回滚，回退版本前需确认数据库兼容性。

### 内网 Git 轮询

Dokploy 没有公网入口时，可在宿主机安装 `deploy/git-auto-deploy.py` 和对应的 systemd service/timer，每分钟检查一次 `main`。只在出现新提交时调用本机 Dokploy Webhook，构建仍由 Dokploy 完成。Webhook URL 写入 `/etc/hub-git-deploy/config.json`（权限 600），格式包含 `repository`、`branch`、`webhook_url` 三个字段；不要提交该文件。脚本安装到 `/usr/local/lib/hub-git-deploy.py`，状态保存在 `/var/lib/hub-git-deploy/last-requested`。已提交但构建失败的版本需在 Dokploy 手动重试。

参考：[Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose)、[自动部署](https://docs.dokploy.com/docs/core/auto-deploy)。
