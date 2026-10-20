# Vibe Quant

行情插件入口：`/p/vibe-quant`。在 **后台 → 插件管理 → Vibe Quant → 参数配置** 选择引擎并填写连接参数，然后启用。

## 已实现

- 用户隔离的自选列表；添加即订阅，Switch 暂停/恢复，删除释放当前用户的订阅。同一标的跨用户合并，单个用户暂停不影响其他用户。
- 搜索代码、名称与分类。`000852` 展示带交易所的结果；`IM2610` 对应 `CFFEX.IM2610`；`MOxxx` 按 `MO` 前缀搜索；`IM主连` 对应连续合约 `KQ.m@CFFEX.IM`，保留动态标的字段。
- TradingView Lightweight Charts 5：下拉切换 1/3/5/15/30/60 分钟、日线和月线，周期与指标同栏；今开、最高、最低、昨收、成交量和持仓量位于右侧盘口上方。支持历史分页、实时增量更新、主题跟随、窄屏布局，历史数据更新保留查看位置。
- 视图周期另含分时图，以最近交易日的 1 分钟收盘价绘制折线，按日线起点保留期货夜盘。选择通过 localStorage 保存，刷新后恢复。名称、当前标的、报价及红涨绿跌的涨跌幅集中展示在左侧自选中，选中项提供同步开关和移除操作。
- 3 分钟线从 1 分钟 K 线聚合；月线从日线时间按上海时区的自然月聚合（接口周期标识 `2592000`，不代表固定 30 天）。聚合前先合并实时数据，保留 OHLC 和累加成交量；可见历史范围取决于已采集的基础周期数据。
- 行情、自选、合约目录、运行状态和采集租约统一存储到 ClickHouse；插件配置（含账号、密码、开关）仍由宿主 PostgreSQL 管理。行情按引擎隔离，失败批次保留在内存并重试。
- 共享 ClickHouse 通过租约选择每个引擎的入库实例，失去租约后拒绝行情写入。引擎配置变化自动重启，停用回收 Python 子进程，异常退避重连。每天按上海日期刷新目录，过期/移除的合约不再开放新订阅。
- 可开启“不写入行情数据”：查询 ClickHouse 历史，实时行情、盘口和 K 线仅在当前服务内存中合并展示；自选、目录和状态仍正常保存。
- TqSdk 最近 Tick 窗口回补与持续采集，保存原始累计成交量、累计成交额和精确时间；自动检查序号缺口、累计量回退，并与已覆盖分钟 K 线对账。本版不实现 Volume Profile 指标。

## 多服务共享 ClickHouse

在 **后台 → 插件管理 → Vibe Quant → 参数配置 → ClickHouse** 开启 **不写入行情数据**（沿用配置键 `clickhouseReadOnly`，默认关闭）。各服务可以使用相同或不同的 ClickHouse 账号，各自的 PostgreSQL 无需共享。所有服务必须连接 **同一台 ClickHouse 24.8+ 服务器、同一个数据库**；当前并发协调不支持请求分散到多个 ClickHouse 节点的负载均衡地址。

开启后，实时行情、盘口和 K 线与历史合并展示，不创建或写入 `quotes`、`bars`、`order_books`、`ticks`，也不额外订阅 Tick。行情表由入库服务预先创建。行情引擎仍需有效连接；每个标的、周期最多保留最近 1000 根内存 K 线，取消订阅后释放缓存，重启后重新采集。行情页显示“行情不落库”和“最近接收”。

采集订阅来自共享 ClickHouse 中所有用户启用标的的并集，因此其他服务添加自选也会被入库服务采集。多个入库服务按引擎竞争共享租约，只有持有租约的实例可写入行情；不落库服务各自采集实时数据，并单独保存运行状态。租约、订阅上限检查使用同一服务器全局查询 ID 序列化单条条件插入，市场数据写入再次校验租约。此机制不会清理既有行情，也不承诺阻止绕过插件的外部写入。

## 状态存储与旧数据迁移

以下表位于 `clickhouseDatabase` 指定的数据库中，不存储插件配置对象或连接凭据。运行状态保留模式、交易窗口等展示字段。

| 表                  | 内容                               | 逻辑主键             |
| ------------------- | ---------------------------------- | -------------------- |
| `quant_watchlist`   | 用户自选、启停、创建时间、删除标记 | `userId, symbol`     |
| `quant_instruments` | 引擎合约目录与过期状态             | `engine, symbol`     |
| `quant_status`      | 每个服务进程的运行状态和心跳       | `engine, instanceId` |
| `quant_leases`      | 行情入库实例及租约到期时间         | `engine`             |
| `quant_migrations`  | 旧 PostgreSQL 数据导入指纹         | `id`                 |

状态表使用 `ReplacingMergeTree`，查询使用 `FINAL`，不按时间分区。自选删除保存墓碑记录，避免未合并的数据或重复迁移恢复旧记录。用户仍按宿主 `userId` 隔离：不同服务只有使用相同用户 ID 才能看到同一份自选；同名登录账号不代表 ID 相同。宿主账号删除不会自动跨库删除 ClickHouse 中的自选。

升级后首次启用插件会读取本服务原来的 `plugin_vibe_quant_instruments`、`plugin_vibe_quant_watchlist` 和 `plugin_vibe_quant_status`，自动导入 ClickHouse。仅补充目标中不存在的记录，不覆盖已有编辑、停用或删除；导入中断可重试。旧 PostgreSQL 表保留作为备份，后续业务读写全部使用 ClickHouse。原有配置迁移维持不变。各服务应完成升级并重新启用，旧版本服务不会参与新的共享协调。

首次建表需要数据库内的 `CREATE TABLE` 权限。所有服务需要读取上述状态表，并写入 `quant_watchlist`、`quant_instruments`、`quant_status`、`quant_migrations`；目录批量导入使用 ClickHouse `input()`，还需 `CREATE TEMPORARY TABLE ON *.*` 权限。入库服务另外需要写入 `quant_leases` 和四张行情表（包括 `ticks`）。已建好状态表后，不落库服务无需创建持久表，也无需行情表 INSERT 权限；账号不能设置为全局 `readonly=1`，因为仍要保存自选等信息。

## 引擎

配置使用 Tabs 分为数据引擎、行情连接、ClickHouse、同步策略。引擎使用下拉选择，只展示所选引擎的连接参数；切换引擎保留其他账号配置。参数由宿主统一校验和保存。账号权限不足会显示同步异常，不会生成模拟行情或自动改用其他数据源。

| 引擎      | 本版支持范围                                 | 必需参数                       | 数据方式                                                                                                                                    |
| --------- | -------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tqsdk`   | SDK 支持的股票、指数、基金、期货、期权、主连 | `tqUser`、`tqPassword`         | `query_quotes` / `query_symbol_info` 批量目录，`get_quote_list` 推送，`get_kline_serial` 多周期历史与增量，`get_tick_serial` 最近窗口和增量 |
| `tushare` | 沪深股票、交易所指数                         | `tushareToken`                 | HTTPS 批量 `rt_k` / `rt_idx_k`；分钟 `rt_min` / `rt_idx_min`；首次回补历史日线                                                              |
| `tdx`     | 沪深 A 股、交易所指数                        | `tdxServers`（预填服务器列表） | PyTDX 批量报价与分页股票/指数 K 线                                                                                                          |

TqSdk 官方为 Python SDK，宿主通过受管理的子进程和 JSONL 接收数据。Tushare 直接请求官方 HTTP API，不依赖 Tushare Python 包。当前适配器共用 Python 工作进程；后续可以为 HTTP 引擎替换执行端，保持存储/API 契约。

Tushare 的股票和指数实时日线、分钟线各自需要对应权限。实时分钟每分钟刷新，日线/报价使用 `pollSeconds`；本版不申请额外历史分钟权限或假定具备无限历史回补能力。首次只加载接口返回的实时分钟窗口与历史日线。

通达信的本版接口没有可靠完整 Tick 日期：以最新日 K 日期标识报价，日内覆盖最新快照，不能作为逐 Tick 历史使用。K 线保留分钟历史；分钟标签转换为起始时刻，股票/指数成交量从手转换为股。该引擎不接扩展期货服务器，期货/期权/主连请选 TqSdk。

通达信使用“行情服务器列表” Textarea，每行填写 `IPv4:端口`，默认预填 8 个节点，来源于 [Mootdx 服务器清单](https://github.com/mootdx/mootdx/blob/master/mootdx/consts.py)。列表可修改、排序，最多 32 行，重复地址自动合并。采集器仅使用该列表，按顺序连接；连接超时、请求异常或无效响应时切换下一节点并重试原请求，空历史窗口正常返回。单次请求每节点最多尝试一次，全池失败后 30 秒退避重试。状态显示当前节点。旧的单独主机/端口字段会迁移到列表，原自定义节点保留在首位。

公共服务器的实际可用性以运行环境验证为准；能建立连接不代表能返回全部股票/指数行情。

## 盘口同步

添加自选后，盘口与报价使用相同订阅、交易时段及开收市偏移，无需另行配置。满宽行情页右侧展示最新买卖价格、委托数量、数据源时间及接收时间，窄屏移至图表下方。开启“不写入行情数据”后会合并当前进程接收的实时盘口。

- TqSdk：读取 `bid_price1..5` / `ask_price1..5`、`bid_volume1..5` / `ask_volume1..5`。任何行情对象更新都会采集，只有委托量变化或尚无最新成交价时也可保存。具体有效档位由标的和账号权限决定。
- 通达信：读取 `bid1..5` / `ask1..5`、`bid_vol1..5` / `ask_vol1..5`。不依赖日 K 请求成功才保存盘口。协议缺少可靠完整交易所时间，`sourceTime` 留空，`timePrecision=unknown`，只记录真实接收时间，不将轮询快照称作交易所 Tick。
- Tushare：股票 `rt_k` 显式申请 `bid_price1,bid_volume1,ask_price1,ask_volume1`，当前接口为一档，数量单位为股；指数 `rt_idx_k` 不请求盘口字段。指数本身没有可交易委托盘口。
- TqSdk、通达信委托量保留源接口单位，并记录 `volumeUnit=source`；不与已换算的成交量混用。缺档、零价格、NaN/Infinity 转为空值；有效价格下的零委托量保留为 0。空盘口也保存，以清除上一快照的旧挂单。

盘口独立保存在 `order_books`，包含 `snapshotId`、`symbol`、`sourceTime`、`receivedAt`（UTC epoch 秒）、`timePrecision`、买卖价格/数量数组（下标 0 为一档）、`volumeUnit`、主连的 `underlying`。按接收月份分区，替换键为 `(engine, symbol, receivedAt, snapshotId)`：同一源时间的多次盘口变化均保留，重试沿用原始 ID 防止重复。`GET /snapshot` 新增 `orderBooks`，仅返回当前用户自选、当前引擎的最新快照。所有已接收快照保留在库中，不自动清理。

盘口是实时订阅/轮询期间观察到的快照，不回补订阅之前或断线期间的逐笔委托。TqSdk 的 `wait_update` 可能合并更新，轮询源按 `pollSeconds` 采样；不保证交易所每次盘口变化都被捕获。

## Tick 采集与成交量校验

TqSdk 入库服务自动对自选的股票、基金、期货和期权调用 `get_tick_serial()`；指数不采集成交 Tick。`historyTicks` 默认 10000，可配置 1–10000。首次订阅和进程重连回补最近窗口，后续读取窗口内全部新增行，包含一次 `wait_update` 合并到达的多条记录。最近一行重新读取以接收修正。Tick 更新独立于行情页刷新和开收市偏移处理，避免过滤迟到的收盘数据。

主连订阅映射到当前实际合约，Tick 以实际合约代码存储，同时订阅该合约的分钟 K 线用于对账。换月后切换实际合约；不会用当前标的给主连过去的 Tick 标注合约，也不会将旧合约与新合约合并计算。Tick 查询主连时返回当前实际合约；查询旧合约需将该合约加入自选。

原始数据存入 `ticks`，按交易月份分区，替换键为 `(engine, symbol, tradingDay, timeNs, tickId)`，查询使用 `FINAL`：

- `tickId` 为 SDK Tick 序号，`timeNs` 为源时间纳秒；JSON 使用十进制字符串，ClickHouse 使用 UInt64，避免 JavaScript 数值精度损失。
- `tradingDay` 根据源时间及官方交易日历确定，夜盘、跨午夜、周五夜盘按所属交易日归组。
- 保存 `last`、累计 `volume` / `amount`、`openInterest`、买卖一价量、`priceTick`、`volumeMultiple`、原始数量单位标记及 `receivedAt`。
- 累计量不直接当成单笔量，不把相邻快照之间的全部增量宣称为最新价上的成交。NaN/Infinity 字段转为空值；异常累计量保留以供校验。
- 重试、重连窗口重放按相同源标识逻辑去重；同一时间不同 Tick 序号保留。所有 Tick 写入复用采集租约校验和队列背压。

入库后自动轮流检查各合约最新采集交易日，每个处理周期最多检查一个合约，同一合约至少间隔 60 秒。结果写入 ClickHouse `quant_status` 的 `tickValidation`，随 `GET /snapshot` 返回当前用户自选范围内的结果；校验失败记为 `tickValidationError`，不使已成功入库的批次重放或停止采集。无需打开行情页才会执行校验。

也可调用插件 API `GET /ticks/validation?symbol=CFFEX.IM2611&tradingDay=2026-10-19`，按自选权限重新校验指定交易日：

| 字段                                                        | 含义                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `baselineVolume`                                            | 第一条已保存 Tick 的累计量；不计入已知增量，非零意味着无法确认开头覆盖       |
| `observedVolume`                                            | 相邻序号连续、累计量有效且未回退的增量之和                                   |
| `sequenceGaps` / `gapVolume`                                | 相邻 Tick 序号异常次数及缺口两端可见的正成交量差；缺口成交量不分配到某个价位 |
| `volumeRegressions` / `amountRegressions`                   | 同一交易日累计成交量或成交额回退次数                                         |
| `invalidRows`                                               | 缺失/负成交量，或已有成交量却没有有效价格的记录数                            |
| `checkedMinutes` / `mismatchedMinutes` / `uncheckedMinutes` | 与同源分钟 K 线完成对账、不一致、暂不具备对账条件的分钟数                    |

分钟校验仅比较有前序基线、序号连续、数值有效、已由后续 Tick 证明结束且有参考 K 线的分钟；首个不完整分钟、最后未结束分钟、缺口或缺 K 线均保留为未校验。`state` 区分 `empty`、`partial`、`warning`、`consistent`；`consistent` 仅表示已覆盖区间的一致性，**不代表全天完整或交易所逐笔完整**。校验从 `FINAL` 原始数据重新计算，因此后续回补能修复此前的缺口结果。

免费最近窗口不等于任意历史日期下载；中断超过窗口、首次订阅前的数据以及进程强杀丢失的窗口外记录无法自动恢复。需要更早数据时应另行接入具备相应权限的历史接口。本版没有 Volume Profile / POC / VAH / VAL 或价位分配算法。

## 安装和配置

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

不需要配置 Python 路径。宿主需有 Python 3.9+（建议 3.11）和 venv/pip；插件通过宿主运行上下文，在 `<WORKSPACE_ROOT>/plugins/vibe-quant/.venv` 自动创建独立环境并安装 `worker/requirements.txt`。依赖指纹不变且导入检查通过时复用环境，首次安装显示准备状态，失败后 30 秒重试。停用会中止准备任务。Docker 镜像预构建依赖 wheel，运行时可离线安装；本地首次安装需要访问 Python 包仓库。Workspace 应挂载持久卷。

清单的 `workspace: true` 申请插件专属空间；代码通过 `context.runtime.paths.pluginRoot` 读取采集脚本和依赖清单，通过 `context.runtime.ensureWorkspace()` 取得持久化目录。迁移自动移除旧的 `pythonPath` 参数，保留账号和行情数据。插件清单默认参与构建；新安装仍由宿主默认停用。

ClickHouse 使用 HTTP(S) 地址 `clickhouseUrl`，以及 `clickhouseDatabase`、`clickhouseUser`、`clickhousePassword`。数据库需预先创建，入库服务在启用时幂等创建 `quotes`、`bars`、`order_books` 与 `ticks`；状态表按需创建。升级后重新启用插件即可建表。账号权限见上方“状态存储与旧数据迁移”。密码仅在后端使用，浏览器行情响应不包含账号信息。

`maxSubscriptions` 限制共享 ClickHouse 下当前引擎所有用户的合并标的数，建议同引擎各服务使用一致上限。降低上限前先暂停多余订阅；存量超额时拒绝启用并提示调整。回补上限是 `historyBars`，TqSdk 最大 8000，通达信每批最多 800。

## 同步窗口

- 全部时钟与展示使用 `Asia/Shanghai`。
- TqSdk：官方交易日历 + 各标的白盘/夜盘交易时段，支持午休、跨午夜以及周五夜盘。
- Tushare：`trade_cal` 交易日历 + 沪深交易时段。
- 通达信：`chinese-calendar` 已公布节假日 + 周一至周五 + 沪深交易时段；未知年份拒绝同步。它不能识别交易所临时停市，遇此情况应暂停订阅。
- `beforeOpenMinutes`、`afterCloseMinutes` 分别在每段交易时段前后扩展，默认提前 5 分钟、延后 10 分钟。
- 初次订阅允许在休市回补历史。TqSdk 保留推送连接，报价和普通 K 线在窗口内持久化增量；Tick 持续消费已订阅序列，保留迟到记录。轮询引擎休市不轮询行情。

浏览器每 2 秒读取报价/状态、每 3 秒读取 K 线，隐藏标签页降频。此版本没有下单入口。

## 验证

```sh
pnpm --filter @plugins/vibe-quant test
pnpm test:plugins
pnpm build
# 集成测试只连接本地临时 ClickHouse 18124，并自动创建/删除隔离 PG schema。
QUANT_INTEGRATION=1 node --import dotenv/config --import tsx --test plugins/vibe-quant/tests/*.test.ts
```

测试覆盖交易时段偏移、午休、周末、跨夜、节假日前夜、未知日历、NaN 数据、搜索别名、引擎能力、数据库参数化、用户隔离、订阅上限、真实 ClickHouse 去重与引擎隔离，以及不落库模式实时合并、分页、缓存上限和独立采集。真实 ClickHouse 测试覆盖状态共享、用户隔离、同账号/跨账号并发订阅上限、租约接管后的旧实例写入拒绝、自动迁移重试及墓碑保留；受限账号验证行情仅 SELECT、状态仍可保存。

Tick 测试另外覆盖最近窗口完整读取、多 Tick 合并到达、纳秒精度、同时间不同序号、主连实际合约映射、跨夜交易日、窗口溢出、重试与重新回补、累计量异常、分钟对账、只含 Tick 的进程批次和失效租约拒绝写入。Python Tick 测试使用 pandas（TqSdk 运行依赖）。

实时行情验证需要使用者提供有效账号/Token/行情服务器；通过构建和隔离测试不代表已验证付费行情权限或生产逐笔数据完整性。断线重连按接口最近窗口回补 K 线和 Tick，不承诺重放窗口之外的中断数据。进程强杀可能丢失尚未入库的内存批次。

接口依据：[TqSdk](https://doc.shinnytech.com/tqsdk/latest/reference/tqsdk.api.html)、[Tushare 股票实时行情](https://tushare.pro/document/2?doc_id=372)、[Tushare 指数实时行情](https://tushare.pro/document/2?doc_id=403)、[PyTDX](https://github.com/rainx/pytdx)、[TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/)。
