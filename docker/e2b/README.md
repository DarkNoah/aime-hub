# E2B 自托管部署

根目录 `compose.yaml` 默认只包含应用的 `web`、`server`、`app-postgres` 三个服务，不加载任何 E2B 服务、部署密钥或初始化依赖。后台仍可配置已有的 E2B 管理 API。

需要一起部署 E2B 时，显式追加根目录 `compose.e2b.yaml`。该可选文件通过 Compose `include` 合并官方 E2B Embed 部署与本项目的接入配置，启动完整 Runtime、构建桌面模板，并让后台直接连接它的管理 API。以下宿主机要求与命令仅用于这个可选部署。

## 宿主机

- 专用 **x86-64 Linux/KVM** 主机，推荐 Ubuntu 24.04，内核 ≥ 6.8、4 KiB 页面、cgroup v2。需要 `/dev/kvm`、`/dev/net/tun`，应用工作区还需要 `/dev/fuse`。虚拟机必须启用嵌套虚拟化。
- Docker Engine ≥ 27、Compose ≥ 2.24。建议至少 12 GiB 内存、20 GiB 空闲磁盘；桌面镜像和应用构建还会占用额外空间。
- 宿主机安装 `iptables`、`rsync`、`e2fsprogs`、`iproute2`，允许访问 Docker Hub、`us-docker.pkg.dev`、`storage.googleapis.com`、GitHub。
- 官方 Runtime 支持 ARM64，但这里固定的官方桌面镜像是 AMD64。`desktop-host-check` 会在 `host-setup` 之前拒绝 ARM64；Docker 的镜像模拟不能替代同架构 KVM。
- 每台宿主机只部署一套：E2B 使用固定端口和 `/var/lib/e2b`、`/fc-*`、`/orchestrator` 等固定宿主机路径。

`host-setup` 是官方特权初始化服务，会进入宿主机配置 KVM/NBD/TUN 模块、sysctl、hugepages、网络规则和目录。默认 `HUGEPAGES=2048` 预留 4 GiB，默认每个桌面最多使用 2 GiB 客体内存；按并发容量增加宿主机资源和 hugepages。完整要求以固定版本的[官方说明](https://github.com/e2b-dev/runtime/blob/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose/README.md)为准。

## 启动与管理

1. 在根目录 `.env` 或 Dokploy 环境变量中设置 `WEB_ORIGINS`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET` 和 `E2B_API_KEY`。密钥格式为 `e2b_` 加至少 32 位随机十六进制字符，可在本机运行 `printf 'e2b_'; openssl rand -hex 32` 生成；不要提交密钥。
2. 在仓库根目录执行 `docker compose -f compose.yaml -f compose.e2b.yaml up -d --build --wait`。首次启动会初始化数据库、下载 Firecracker 等二进制、构建 `base` 和 `desktop` 模板。应用后端等桌面模板成功完成后才启动。Dokploy 也需同时加载这两个 Compose 文件。
3. 将应用 HTTPS 入口路由至 `web:80`；首次部署在 `server` 容器运行 `pnpm auth:create-admin`。
4. 打开 **管理后台 → 系统设置 → E2B Desktop**，选择“测试连接”，然后管理实例。连接配置已由部署注入，无需再次填写。

后台通过 `host.docker.internal:3000` 访问宿主机 E2B API；Linux 上由 `host-gateway` 映射。`seed`、`desktop-template` 和 `server` 使用同一个 `E2B_API_KEY`。部署配置优先于数据库中的旧配置；后台显示“部署配置”，禁止改写连接项，其他系统设置仍可正常保存。密钥不写入应用数据库、不回传浏览器，`ready` 服务也不打印密钥。

完整可选部署包含 23 个服务，初始化后常驻 13 个。只使用项目后台管理时，可在上述启动命令最后追加 `web`，仅启动它及其依赖：10 个常驻服务和 10 个一次性初始化任务，不启动独立 `dashboard`、`dashboard-api`、`ready`。所有后续 `up`、`logs`、`down` 等命令都需带上相同的两个 `-f` 参数。

| 环境变量                      | 默认值                   | 用途                                  |
| ----------------------------- | ------------------------ | ------------------------------------- |
| `E2B_API_KEY`                 | 必填                     | E2B 团队密钥，三个服务共用            |
| `E2B_DESKTOP_TEMPLATE`        | `desktop`                | 构建和创建时使用的模板别名            |
| `E2B_DESKTOP_TIMEOUT_SECONDS` | `300`                    | 创建实例默认存活秒数，后台可单次覆盖  |
| `E2B_DESKTOP_CPU_COUNT`       | `2`                      | 桌面模板 vCPU 数量                    |
| `E2B_DESKTOP_MEMORY_MB`       | `2048`                   | 桌面模板内存 MiB                      |
| `E2B_DESKTOP_FORCE_REBUILD`   | `0`                      | `1` 时重新构建已有桌面模板            |
| `E2B_DESKTOP_IMAGE`           | 固定 digest，见 override | 构建来源，须兼容 AMD64 桌面启动脚本   |
| `E2B_DASHBOARD_HOST`          | `localhost`              | 独立 E2B Dashboard 使用的沙箱代理地址 |
| `HUGEPAGES`                   | `2048`                   | 宿主机预留的 2 MiB 大页数量           |

CPU、内存或镜像变更需要重建模板。把 `E2B_DESKTOP_FORCE_REBUILD=1` 写入部署环境并重新 `up`，成功后改回 `0`。默认已存在 ready 模板时跳过构建。新实例使用新版本，正在运行的实例不会原地改变模板。模板固定启动用户 `user`、XFCE 和 1280×720 显示；Agent 桌面控制和视频流接入是独立能力，当前管理页面负责实例生命周期。

## 网络

E2B 官方服务使用宿主机网络；数据库等端口只映射到 loopback。应用 `server:3001` 位于 Docker bridge，不占宿主机的 Dashboard `3001`。

| 宿主机端口                                             | 用途                                        | 访问范围                            |
| ------------------------------------------------------ | ------------------------------------------- | ----------------------------------- |
| `3000`                                                 | E2B 管理 API                                | 应用 Docker bridge 和可信管理客户端 |
| `3001`、`3002`                                         | 独立 Dashboard、沙箱代理                    | 可信客户端；远程使用 SSH 隧道       |
| `5008`                                                 | 编排器与模板上传                            | **未鉴权控制接口，仅限宿主机内部**  |
| `3003`、`3010`、`5007`、`5009`、`5109`、`6060`、`6061` | 内部健康、Dashboard API、gRPC、诊断         | 仅限宿主机内部                      |
| `5432`、`6379`、`8123`、`9000`、`30006`                | E2B PostgreSQL、Redis、ClickHouse、日志接收 | Compose 绑定 `127.0.0.1`            |

在宿主机防火墙中禁止外部访问内部端口，规则也须覆盖宿主机自身的公网地址。不要将 `5008` 反向代理到公网。API `3000` 要允许应用容器所在 bridge 网段访问。可通过 `ssh -N -L 3001:127.0.0.1:3001 -L 3002:127.0.0.1:3002 user@host` 使用独立 Dashboard，登录使用同一个团队密钥。应用后台通过自身的管理员鉴权代理管理请求，不需要向浏览器暴露 E2B 密钥。

## 数据与升级

- 应用 PostgreSQL 服务由 `postgres` 改名为 `app-postgres`，继续挂载原 `postgres-data`；工作区继续使用 `workspace-data`。部署时保持原 Compose 项目名，避免创建另一组空卷。
- E2B 的 `postgres`、`redis`、`clickhouse`、`seed-state` 是独立命名卷。模板、快照和运行时文件还位于宿主机 `/var/lib/e2b` 等目录；备份时同时保留数据库、seed-state 和这些目录。
- 旧的可选 `desktop` 服务已经移除，原 `desktop-data` 卷不会删除，也不会自动迁入新沙箱；确认旧容器名称后可单独停止它。
- 普通停机使用 `docker compose -f compose.yaml -f compose.e2b.yaml down`，保留数据。**不要使用 `down -v`，它会连同应用数据库和工作区一起删除。** 官方 `host-teardown` 还会清理 E2B 宿主机数据，只用于明确的完整卸载。
- 宿主机重启后再次执行 `docker compose -f compose.yaml -f compose.e2b.yaml up -d --wait`，重新应用非持久网络规则与命名空间设置。编排器重启会结束当前运行的沙箱。
- 更换 `E2B_API_KEY` 后重新 `up`，seed 撤销旧团队密钥，API 缓存使旧密钥最多再生效五分钟。不要用上游 `TEAM_API_KEY` 覆盖本项目的 `E2B_API_KEY`。
- 从完整部署切回默认 Compose，不会自动停止已运行的 E2B 容器。需要停用时，先用上面的完整停机命令关闭项目，再执行 `docker compose up -d --build --wait` 启动三个应用服务；这会短暂中断应用，但保留数据卷。移除部署注入后，后台恢复使用数据库里保存的外部 E2B 连接配置。

## 检查与排障

```sh
docker compose -f compose.yaml -f compose.e2b.yaml ps -a
docker compose -f compose.yaml -f compose.e2b.yaml logs desktop-host-check preflight host-setup
docker compose -f compose.yaml -f compose.e2b.yaml logs base-template desktop-template
docker compose -f compose.yaml -f compose.e2b.yaml logs api orchestrator client-proxy
docker compose -f compose.yaml -f compose.e2b.yaml --profile test run --rm smoke
```

`smoke` 是官方通用 Runtime 冒烟检查。桌面验收应在后台完成创建 → 修改存活时间 → 删除，并核对列表结果。失败后修正配置再执行 `up`，初始化步骤可重复运行。`E2B_DESKTOP_FORCE_REBUILD=1` 可重建桌面模板；不要以删除数据卷作为排障步骤。

## 上游来源

`compose.upstream.yaml` 和 `images.env` 分别原样复制自 [e2b-dev/runtime](https://github.com/e2b-dev/runtime/tree/4f35ab01d346408b29b843eac98fdea61a21f8d1/embed/compose) 的 `embed/compose/compose.yaml` 和 `embed/compose/.env`，固定提交 `4f35ab01d346408b29b843eac98fdea61a21f8d1`，Apache-2.0 许可证保存在 `LICENSE.upstream`。`images.env` 只含公开版本，不含部署密钥。集成差异放在 `compose.integration.yaml` 和本目录的桌面脚本中。

| 原样文件                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `compose.upstream.yaml` | `658429e02665fa9e1cc23411e0897b1e2db1867e6fa9c47fb551ac5a313b6b74` |
| `images.env`            | `484510816c685a4d6d24bff34d00b05c46306146c0be397507dc215390a182fa` |

升级时同时更新这两个上游文件，检查对应 Runtime 发布和本地 override 的合并结果，再验证桌面构建与实例生命周期。不要只把某一个服务镜像改为 `latest`。
