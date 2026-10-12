# Dokploy 部署

仓库使用多阶段 `Dockerfile` 和 `compose.yaml`：`web` 用 Nginx 提供前端并代理 `/api`，`server` 运行 API，`postgres` 使用独立 PostgreSQL 数据库。前端与 API 共用 HTTPS 域名，代理关闭 SSE 缓冲。

## 运行环境

服务容器包含 Node.js 22、npm、pnpm 10.12.1、Bun 1、Python 3（含 pip、venv）、FFmpeg、Git、curl、jq、zip/unzip、ripgrep、编译工具、Chromium 和 AgentFS 0.6.4。Python 默认使用 `/opt/python` 虚拟环境，可以直接执行 `python`、`pip`。

项目共享工作区需要 Linux FUSE，因此仅 `server` 配置 `/dev/fuse`、`SYS_ADMIN` 和 `apparmor:unconfined`，宿主机须提供 `/dev/fuse`。不要运行多个 API 副本：队列、调度器和工作区挂载由单个进程管理。

## Dokploy 配置

1. 创建 Docker Compose 服务，来源选择 **Git**，仓库为 `https://github.com/DarkNoah/aime-hub.git`，分支为 `main`，Compose 路径为 `./compose.yaml`。
2. 配置以下环境变量。密钥只保存在 Dokploy，不能提交到 Git：

   ```dotenv
   WEB_ORIGIN=https://your-domain.example
   POSTGRES_PASSWORD=<随机字母数字密码，用于数据库连接 URL>
   BETTER_AUTH_SECRET=<至少 32 字符的随机密钥>
   ADMINS=admin
   TZ=Asia/Shanghai
   ```

   可选配置 `WEB_ORIGINS`、`WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY`、`WEB_PUSH_SUBJECT`。镜像仓库受限时可通过 `NODE_IMAGE`、`NGINX_IMAGE`、`BUN_IMAGE`、`POSTGRES_IMAGE` 指定可用镜像源。

3. 在 Domains 中将域名路由至 `web:80`，启用 HTTPS。域名必须指向入口服务器，并允许证书验证流量到达入口。
4. 部署。服务启动前执行幂等数据库迁移；API 健康后才启动 Web。
5. 在 `server` 容器终端运行 `pnpm auth:create-admin`，交互输入管理员邮箱、用户名和密码。没有默认管理员密码。

`postgres-data` 和 `workspace-data` 使用命名卷，重新部署保留数据。不要启用 Fresh Volumes 或执行 `docker compose down -v`，除非有意清空数据。备份应同时覆盖 PostgreSQL 与工作区卷。模型供应商在新数据库中需由管理员重新配置。

## Git 自动更新

在 Dokploy 开启 Auto Deploy，并将 Deployments 页面提供的 Webhook URL 加入 GitHub 仓库的 Webhooks，事件选择 `push`、内容类型选择 `application/json`。GitHub 必须能访问该 URL；仅内网地址无法接收 GitHub 回调。推送 `main` 后，Dokploy 重新拉取代码、构建 Dockerfile、执行迁移并更新容器。

检查 GitHub webhook delivery 与 Dokploy 部署记录，确认自动部署成功，而不只是打开开关。数据库迁移不自动回滚，回退版本前需确认数据库兼容性。

参考：[Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose)、[自动部署](https://docs.dokploy.com/docs/core/auto-deploy)。
