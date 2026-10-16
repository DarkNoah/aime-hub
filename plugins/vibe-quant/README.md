# Vibe Quant

行情插件入口：`/p/vibe-quant`。在 **后台 → 插件管理 → Vibe Quant → 参数配置** 选择引擎并填写连接参数，然后启用。

## 已实现

- 用户隔离的自选列表；添加即订阅，Switch 暂停/恢复，删除释放当前用户的订阅。同一标的跨用户合并，单个用户暂停不影响其他用户。
- 搜索代码、名称与分类。`000852` 展示带交易所的结果；`IM2610` 对应 `CFFEX.IM2610`；`MOxxx` 按 `MO` 前缀搜索；`IM主连` 对应连续合约 `KQ.m@CFFEX.IM`，保留动态标的字段。
- TradingView Lightweight Charts 5：1/5/15/30/60 分钟、日线、成交量、历史分页、实时增量更新、主题跟随、窄屏布局。历史数据更新保留查看位置。
- 行情快照、买卖盘口历史和 K 线存储到 ClickHouse；自选、合约目录、工作进程心跳存储到宿主 PostgreSQL。数据按引擎隔离，使用替换键去重，失败批次保留在内存并重试。
- PostgreSQL 会话级 advisory lock 保证同一宿主数据库只有一个采集实例；引擎配置变化自动重启，停用回收 Python 子进程，异常退避重连。每天按上海日期刷新目录，过期/移除的合约不再开放新订阅。

## 引擎

配置使用 Tabs 分为数据引擎、行情连接、ClickHouse、同步策略。引擎使用下拉选择，只展示所选引擎的连接参数；切换引擎保留其他账号配置。参数由宿主统一校验和保存。账号权限不足会显示同步异常，不会生成模拟行情或自动改用其他数据源。

| 引擎      | 本版支持范围                                 | 必需参数                       | 数据方式                                                                                                  |
| --------- | -------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `tqsdk`   | SDK 支持的股票、指数、基金、期货、期权、主连 | `tqUser`、`tqPassword`         | `query_quotes` / `query_symbol_info` 批量目录，`get_quote_list` 推送，`get_kline_serial` 多周期历史与增量 |
| `tushare` | 沪深股票、交易所指数                         | `tushareToken`                 | HTTPS 批量 `rt_k` / `rt_idx_k`；分钟 `rt_min` / `rt_idx_min`；首次回补历史日线                            |
| `tdx`     | 沪深 A 股、交易所指数                        | `tdxServers`（预填服务器列表） | PyTDX 批量报价与分页股票/指数 K 线                                                                        |

TqSdk 官方为 Python SDK，宿主通过受管理的子进程和 JSONL 接收数据。Tushare 直接请求官方 HTTP API，不依赖 Tushare Python 包。当前适配器共用 Python 工作进程；后续可以为 HTTP 引擎替换执行端，保持存储/API 契约。

Tushare 的股票和指数实时日线、分钟线各自需要对应权限。实时分钟每分钟刷新，日线/报价使用 `pollSeconds`；本版不申请额外历史分钟权限或假定具备无限历史回补能力。首次只加载接口返回的实时分钟窗口与历史日线。

通达信的本版接口没有可靠完整 Tick 日期：以最新日 K 日期标识报价，日内覆盖最新快照，不能作为逐 Tick 历史使用。K 线保留分钟历史；分钟标签转换为起始时刻，股票/指数成交量从手转换为股。该引擎不接扩展期货服务器，期货/期权/主连请选 TqSdk。

通达信使用“行情服务器列表” Textarea，每行填写 `IPv4:端口`，默认预填 8 个节点，来源于 [Mootdx 服务器清单](https://github.com/mootdx/mootdx/blob/master/mootdx/consts.py)。列表可修改、排序，最多 32 行，重复地址自动合并。采集器仅使用该列表，按顺序连接；连接超时、请求异常或无效响应时切换下一节点并重试原请求，空历史窗口正常返回。单次请求每节点最多尝试一次，全池失败后 30 秒退避重试。状态显示当前节点。旧的单独主机/端口字段会迁移到列表，原自定义节点保留在首位。

公共服务器的实际可用性以运行环境验证为准；能建立连接不代表能返回全部股票/指数行情。

## 盘口同步

添加自选后，盘口与报价使用相同订阅、交易时段及开收市偏移，无需另行配置。满宽行情页右侧展示最新已入库的买卖价格、委托数量、数据源时间及接收时间，窄屏移至图表下方。

- TqSdk：读取 `bid_price1..5` / `ask_price1..5`、`bid_volume1..5` / `ask_volume1..5`。任何行情对象更新都会采集，只有委托量变化或尚无最新成交价时也可保存。具体有效档位由标的和账号权限决定。
- 通达信：读取 `bid1..5` / `ask1..5`、`bid_vol1..5` / `ask_vol1..5`。不依赖日 K 请求成功才保存盘口。协议缺少可靠完整交易所时间，`sourceTime` 留空，`timePrecision=unknown`，只记录真实接收时间，不将轮询快照称作交易所 Tick。
- Tushare：股票 `rt_k` 显式申请 `bid_price1,bid_volume1,ask_price1,ask_volume1`，当前接口为一档，数量单位为股；指数 `rt_idx_k` 不请求盘口字段。指数本身没有可交易委托盘口。
- TqSdk、通达信委托量保留源接口单位，并记录 `volumeUnit=source`；不与已换算的成交量混用。缺档、零价格、NaN/Infinity 转为空值；有效价格下的零委托量保留为 0。空盘口也保存，以清除上一快照的旧挂单。

盘口独立保存在 `order_books`，包含 `snapshotId`、`symbol`、`sourceTime`、`receivedAt`（UTC epoch 秒）、`timePrecision`、买卖价格/数量数组（下标 0 为一档）、`volumeUnit`、主连的 `underlying`。按接收月份分区，替换键为 `(engine, symbol, receivedAt, snapshotId)`：同一源时间的多次盘口变化均保留，重试沿用原始 ID 防止重复。`GET /snapshot` 新增 `orderBooks`，仅返回当前用户自选、当前引擎的最新快照。所有已接收快照保留在库中，不自动清理。

盘口是实时订阅/轮询期间观察到的快照，不回补订阅之前或断线期间的逐笔委托。TqSdk 的 `wait_update` 可能合并更新，轮询源按 `pollSeconds` 采样；不保证交易所每次盘口变化都被捕获。

## 安装和配置

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

不需要配置 Python 路径。宿主需有 Python 3.9+（建议 3.11）和 venv/pip；插件通过宿主运行上下文，在 `<WORKSPACE_ROOT>/plugins/vibe-quant/.venv` 自动创建独立环境并安装 `worker/requirements.txt`。依赖指纹不变且导入检查通过时复用环境，首次安装显示准备状态，失败后 30 秒重试。停用会中止准备任务。Docker 镜像预构建依赖 wheel，运行时可离线安装；本地首次安装需要访问 Python 包仓库。Workspace 应挂载持久卷。

清单的 `workspace: true` 申请插件专属空间；代码通过 `context.runtime.paths.pluginRoot` 读取采集脚本和依赖清单，通过 `context.runtime.ensureWorkspace()` 取得持久化目录。迁移自动移除旧的 `pythonPath` 参数，保留账号和行情数据。插件清单默认参与构建；新安装仍由宿主默认停用。

ClickHouse 使用 HTTP(S) 地址 `clickhouseUrl`，以及 `clickhouseDatabase`、`clickhouseUser`、`clickhousePassword`。数据库需预先创建，插件在启用时幂等创建 `quotes`、`bars` 与 `order_books` 表。升级仅新增盘口表，不重写已有行情。账号需拥有此库的建表、查询、插入权限。密码仅在后端使用，浏览器行情响应不包含账号信息。

`maxSubscriptions` 限制所有用户的合并标的数。降低上限前先暂停多余订阅；存量超额时拒绝启用并提示调整。回补上限是 `historyBars`，TqSdk 最大 8000，通达信每批最多 800。

## 同步窗口

- 全部时钟与展示使用 `Asia/Shanghai`。
- TqSdk：官方交易日历 + 各标的白盘/夜盘交易时段，支持午休、跨午夜以及周五夜盘。
- Tushare：`trade_cal` 交易日历 + 沪深交易时段。
- 通达信：`chinese-calendar` 已公布节假日 + 周一至周五 + 沪深交易时段；未知年份拒绝同步。它不能识别交易所临时停市，遇此情况应暂停订阅。
- `beforeOpenMinutes`、`afterCloseMinutes` 分别在每段交易时段前后扩展，默认提前 5 分钟、延后 10 分钟。
- 初次订阅允许在休市回补历史。TqSdk 保留推送连接，仅在窗口内持久化增量；轮询引擎休市不轮询行情。

浏览器每 2 秒读取报价/状态、每 3 秒读取 K 线，隐藏标签页降频。此版本没有下单入口。

## 验证

```sh
pnpm --filter @plugins/vibe-quant test
pnpm test:plugins
pnpm build
# 集成测试只连接本地临时 ClickHouse 18124，并自动创建/删除隔离 PG schema。
QUANT_INTEGRATION=1 node --import dotenv/config --import tsx --test plugins/vibe-quant/tests/integration.test.ts
```

测试覆盖交易时段偏移、午休、周末、跨夜、节假日前夜、未知日历、NaN 数据、搜索别名、引擎能力、数据库参数化、用户隔离、订阅上限、真实 ClickHouse 去重与引擎隔离。

实时行情验证需要使用者提供有效账号/Token/行情服务器；通过构建和隔离测试不代表已验证付费行情权限或生产逐笔数据完整性。断线重连按接口历史窗口回补 K 线，不承诺重放中断期间的全部 Tick。进程强杀可能丢失尚未入库的内存批次。

接口依据：[TqSdk](https://doc.shinnytech.com/tqsdk/latest/reference/tqsdk.api.html)、[Tushare 股票实时行情](https://tushare.pro/document/2?doc_id=372)、[Tushare 指数实时行情](https://tushare.pro/document/2?doc_id=403)、[PyTDX](https://github.com/rainx/pytdx)、[TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/)。
