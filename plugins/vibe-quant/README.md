# Vibe Quant

行情插件入口：`/p/vibe-quant`。在 **后台 → 插件管理 → Vibe Quant → 参数配置** 选择引擎并填写连接参数，然后启用。

## 已实现

- 用户隔离的自选列表；添加即订阅，Switch 暂停/恢复，删除释放当前用户的订阅。同一标的跨用户合并，单个用户暂停不影响其他用户。
- 搜索代码、名称与分类。`000852` 展示带交易所的结果；`IM2610` 对应 `CFFEX.IM2610`；`MOxxx` 按 `MO` 前缀搜索；`IM主连` 对应连续合约 `KQ.m@CFFEX.IM`，保留动态标的字段。
- TradingView Lightweight Charts 5：下拉切换 1/3/5/15/30/60 分钟、日线和月线，周期与指标同栏；今开、最高、最低、昨收、成交量和持仓量位于右侧盘口上方。支持历史分页、实时增量更新、主题跟随、窄屏布局，历史数据更新保留查看位置。
- 主图 SMC 智能资金参照 stock-rl：BOS/CHoCH、订单块、EQH/EQL、FVG、强弱高低点及溢价折价区；通过主图指标菜单开关及配置，参数本地保存。多周期依赖已加载历史，具体口径与来源见 [指标说明](web/indicators/README.md)。
- 图内信息栏随十字光标显示对应 K 线的日期时间（UTC+8）、开高低收、成交量和成交额；移出图表后显示当前加载区间最新一根，空白区域显示缺失标记。分钟周期的时间轴、十字光标和信息栏统一按 K 线结束时间标注，例如 `[09:30, 09:31)` 显示为 09:31，与 stock-rl 的收盘时间标注约定一致；分时图也使用分钟结束时间，日线/月线保留原有日期/月标签。日期跳转指定时间时按同一显示时间定位，时间留空仍从当天 00:00 定位。存储/API、翻页游标、划线锚点和 Tick 汇总区间继续使用原始起始时间。成交额保留数据源的单根 K 线值并统一为元，Tushare 历史日线的千元单位乘以 1000；TqSdk 缺失值尝试从已保存的同合约 Tick 汇总，覆盖不足时显示“—”，不通过收盘价乘成交量估算。
- 视图周期另含分时图，以最近交易日的 1 分钟收盘价绘制折线，按日线起点保留期货夜盘。选择通过 localStorage 保存，刷新后恢复。名称、当前标的、报价及红涨绿跌的涨跌幅集中展示在左侧自选中，选中项提供同步开关和移除操作。
- 3 分钟线从 1 分钟 K 线聚合；月线从日线时间按上海时区的自然月聚合（接口周期标识 `2592000`，不代表固定 30 天）。聚合前先合并实时数据，保留 OHLC 和累加成交量；可见历史范围取决于已采集的基础周期数据。
- 行情、自选、合约目录、运行状态和采集租约统一存储到 ClickHouse；插件配置（含账号、密码、开关）仍由宿主 PostgreSQL 管理。行情按引擎隔离，失败批次保留在内存并重试。
- 共享 ClickHouse 通过租约选择每个引擎的入库实例，失去租约后拒绝行情写入。引擎配置变化自动重启，停用回收 Python 子进程，异常退避重连。每天按上海日期刷新目录，过期/移除的合约不再开放新订阅。
- 可开启“不写入行情数据”：查询 ClickHouse 历史，实时行情、盘口和 K 线仅在当前服务内存中合并展示；自选、目录和状态仍正常保存。
- TqSdk 最近 Tick 窗口回补与持续采集，保存原始累计成交量、累计成交额和精确时间；自动检查序号缺口、累计量回退，并与已覆盖分钟 K 线对账。本版不实现 Volume Profile 指标。
- 资讯聚合：`/p/vibe-quant/news`，12 个行业、106 个 RSS/Atom 源，来源筛选、标题/摘要搜索、游标翻页及正文阅读；后台独立采集，通过 Playwright 优先读取完整正文。

## 资讯聚合

资讯源清单移植自 [Vibe-Research 的 rss_sources.json](https://github.com/simonlin1212/Vibe-Research/blob/main/datasources/rss_sources.json)，上游为 [investment-news](https://github.com/simonlin1212/investment-news)。本次锁定源清单 blob `fd04152cb0c076dbdcc0e1df093cd63ffda98073`，实际 106 个源、12 个行业；来源和 MIT 许可保留在 `server/news/sources.json` 与 `server/news/LICENSE.investment-news`。只复用源清单，不导入上游的内容屏蔽词表；完整性和站点可用性以实际抓取结果为准。

在 **后台 → 插件管理 → Vibe Quant → 参数配置 → 资讯聚合** 中使用 **资讯同步** 开关（`newsEnabled`，默认开启），点击保存后生效。关闭会中止当前 RSS/正文抓取、停止后续同步并释放采集租约，已有资讯仍可阅读，来源配置保留；重新开启后继续轮询和处理待抓取正文。此开关独立于行情同步；保存参数沿用宿主的插件重载流程。多实例分别管理配置时，每个实例都需关闭，才能停止共享资讯库的全部采集。

同组还可设置目标轮询间隔（默认 120 秒）、正文并发（默认 3）、连续失败停用阈值（默认 3）及资讯数据库（默认 `vibe_quant_news`）。沿用插件 ClickHouse HTTP 地址和凭据，启用时执行幂等建库建表；账号需具有目标库的 CREATE DATABASE / CREATE TABLE / ALTER / SELECT / INSERT 权限。新闻存储与“不写入行情数据”开关独立。源新增、编辑、删除和启停是管理员操作，对同库的所有用户生效。删除使用持久化标记，保留历史新闻，服务重启不会重新导入已删除的内置源；再次添加同一地址可恢复来源。

| 表                  | 内容                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `news_sources`      | 来源 ID、名称、行业、RSS 地址、启停/删除状态、正文连续失败次数、停用原因和自动停用标记                   |
| `news_source_state` | 最近尝试/成功、ETag、Last-Modified、下次轮询、错误及连续失败次数                                         |
| `news_articles`     | 标题、URL、摘要、来源、原始发布时间、UTC epoch 发布时间、首次发现时间、正文状态/提供方/截断标记/重试信息 |
| `news_contents`     | 完整 Markdown 正文，独立存储以避免列表读取正文                                                           |
| `news_lease`        | 共享采集租约与心跳，失去租约后拒绝写入                                                                   |

没有发布时间时保持 `publishedAt=null`，页面标注发现时间，所有展示时间为北京时间。同一来源的规范化 URL 去重，仅剥离明确的跟踪参数；保留 `?p=` / `?id=` 等文章标识，同一文章的不同来源记录分别保留。重复轮询不会覆盖已保存正文。正文失败保留摘要、错误及退避重试时间，不将摘要标为完整正文；不按字符数截断正文，不将部分正文标为成功；响应超过 5 MB 的安全读取上限会失败重试。旧截断记录应重新入队，阅读器不再展示它们为完整正文。

RSS 使用宿主的安全 HTTP 传输（逐跳地址校验、响应体大小限制、条件请求），正文直接按 URL 调用宿主文章读取器，优先 Playwright 渲染（35 秒总时限），失败后尝试 HTTP 读取（20 秒）。它不调用 Agent 的 `web_fetch` 工具，也不受该工具启用状态、供应商或 `maxChars` 限制。两者仅共享底层安全传输和正文解析代码。微信文章等待 `#js_content`，解析懒加载图片、代码段和部分 `JsDecode` 内嵌正文；验证页、失效文章或空壳会记录具体错误，不保存为成功。Playwright 不保证解决验证码，遇到验证不会绕过。资讯源与正文队列独立运行，不需要打开页面，非交易时段也采集；正文批次一半优先最新资讯，另一半处理积压和到期重试。单篇正文失败按 30 秒起指数退避，RSS 失败按轮询间隔起退避，上限均一小时。同一源正文连续失败达到阈值或 RSS 连续失败达到阈值时自动停用，持久保存错误码（例如 `WECHAT_VERIFICATION_REQUIRED`）并在源管理中解释原因；RSS 成功不会清除正文失败计数。停用后不再派发新请求，已在途请求会结束；管理员重新启用时清除计数和停用原因，恢复轮询及到期正文重试。停用插件会中止请求并释放租约。多实例必须直连同一 ClickHouse 24.8+ 服务，共享新闻库；租约及写入采用同一查询锁，负载均衡到不同服务器不提供此保证。

来源可选择「读取原文网页」（默认）或「仅保存 RSS 自带正文」。后者只读取 RSS `content:encoded` / Atom `content`，转换并完整保存为 Markdown；没有正文字段、仅有 `description` / `summary`、或清理后正文为空的条目不入库，也不进入网页抓取队列。正文标记 `contentProvider=rss`；来源模式保存到 ClickHouse `news_sources.contentMode`，在来源编辑中可查看与更改。AIHOT 的 `https://aihot.news/feed/full.xml` 使用此模式。

页面每 15 秒检查新数据，用「新资讯」按钮插入列表以保持阅读位置。源目标间隔不等于交易所行情推送：源更新频率、网络和队列都会影响延迟。初次采集每个源最多读取 200 条当前条目，不承诺历史全量回补，也不绕过付费墙。数据没有自动 TTL，部署方按自己的保留策略管理。

会话 API：`GET /news`（industry/source/q/cursor/limit）、`GET /news/overview`、`GET /news/:id`；管理员可 `POST /news/sources`、`PATCH /news/sources/:id`（name/industry/url/enabled/contentMode）和 `DELETE /news/sources/:id`。路径前缀均为 `/api/plugins/vibe-quant`。

验证：`node --import tsx --test plugins/vibe-quant/tests/news.test.ts`；微信适配及实际浏览器测试使用 `TEST_WEB_FETCH_BROWSER=1 node --import tsx --test scripts/wechat-fetch.test.ts scripts/web-fetch.test.ts`；真实数据库隔离测试使用 `QUANT_INTEGRATION=1 TEST_WEB_FETCH_BROWSER=1 node --import tsx --test plugins/vibe-quant/tests/news-integration.test.ts`，连接本机 `18124` 测试 ClickHouse，并在唯一临时数据库中创建/清理数据。

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

成交量分布独立使用与 stock-rl 相同的通达信分笔接口（`node-tdx-market@0.2.1`），按图表请求补齐历史分页并保存到 `tdx_trade_days`。此表按标的、北京时间自然日保存整日分笔数组，原子替换并保留重复分笔，避免将每笔成交量与 TqSdk 的累计量混用。当前日按需刷新，历史日读取存储；K 线和盘口采集流程不变。分笔连接位于插件参数「分笔成交」，股票默认 `124.71.187.122:7709`，期货默认 `116.205.143.214:7727`；行情只读模式只读已有分笔。配色及时间范围见 [指标说明](web/indicators/README.md#成交量分布)。

K 线查询会从 `ticks FINAL` 同时重建 OHLC 并补齐缺失成交额，直接按请求周期计算。要求序号连续、累计成交量有效且不回退、区间起点有基线、末尾有连续的后续 Tick 证明结束，并与该根源 K 线成交量对账。OHLC 只采用成交量增量大于 0 的 Tick 最新价：首条为开盘、最后一条为收盘、最大/最小值为最高/最低，排除前一根收盘价及无成交的报价变化。区间存在缺口、未结束、成交量不一致、成交 Tick 价格无效或无成交时，整组 OHLC 保留源 K 线，不混用部分重建值。历史分页、日期跳转、主副图指标均使用查询返回的同一组价格。

成交额仍按累计额差分汇总，不把累计额直接相加；额还须有效、不回退且与成交量变化一致。缺失累计额不影响满足条件的 OHLC 重建，但成交额继续返回 NULL（界面“—”）。零成交量且累计额不变可返回 0，数据源已有单根成交额时保留原值。换交易日重置累计基线；日线和月线按 Tick 的 `tradingDay` 归属，涵盖前一晚夜盘、跨周末和跨月夜盘。

实际期货和期权合约统一使用上述重建逻辑，不限定合约代码；切换合约、周期、分页或日期跳转都会重新校验。主连 `KQ.m@` 根据已保存的历史 `quotes.underlying` 连续记录选择当时的实际合约，要求整根 K 线落在同一个已观察到的合约区间内。日线/月线还会根据 Tick 实际时间向前查找夜盘映射，包含跨周末和跨月夜盘。历史映射不足、映射为空或一根 K 线跨越换月时保留源数据，不用最新合约倒推历史，也不把不同合约的 Tick 拼接；加权指数 `KQ.i@` 没有单一实际合约，保留源 K 线。

该计算只读已有数据，不增加 Tick 订阅或覆盖原始 K 线；后续查询都会重新校验，回补或更正 Tick/历史映射后可修复结果。只读服务有 `ticks`（主连还需要 `quotes`）的 SELECT 权限即可使用；旧库没有所需表、无读取权限或查询超过保护限额时保留源 K 线和缺失成交额。完整性以已采集的同源快照为准；快照并非交易所逐笔，不能据此承诺任意区间与另一数据源逐点一致。

免费最近窗口不等于任意历史日期下载；中断超过窗口、首次订阅前的数据以及进程强杀丢失的窗口外记录无法自动恢复。需要更早数据时应另行接入具备相应权限的历史接口。本版没有 Volume Profile / POC / VAH / VAL 或价位分配算法。

## 安装和配置

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

不需要配置 Python 路径。宿主需有 Python 3.10+（建议 3.11）和 venv/pip；插件通过宿主运行上下文，在 `<WORKSPACE_ROOT>/plugins/vibe-quant/.venv` 自动创建独立环境并安装 `worker/requirements.txt`。依赖指纹不变且导入检查通过时复用环境，首次安装显示准备状态，失败后 30 秒重试。停用会中止准备任务。Docker 镜像预构建依赖 wheel，运行时可离线安装；本地首次安装需要访问 Python 包仓库。Workspace 应挂载持久卷。

清单的 `workspace: true` 申请插件专属空间；代码通过 `context.runtime.paths.pluginRoot` 读取采集脚本和依赖清单，通过 `context.runtime.ensureWorkspace()` 取得持久化目录。迁移自动移除旧的 `pythonPath` 参数，保留账号和行情数据。插件清单默认参与构建；新安装仍由宿主默认停用。

ClickHouse 使用 HTTP(S) 地址 `clickhouseUrl`，以及 `clickhouseDatabase`、`clickhouseUser`、`clickhousePassword`。数据库需预先创建，入库服务在启用时幂等创建 `quotes`、`bars`、`order_books` 与 `ticks`；状态表按需创建。升级后重新启用插件即可建表。账号权限见上方“状态存储与旧数据迁移”。密码仅在后端使用，浏览器行情响应不包含账号信息。

K 线成交额升级由入库服务幂等添加 `bars.amount Nullable(Float64)`，需该表的 `ALTER ADD COLUMN` 权限；已有记录默认 NULL，后续源数据回补才会填入。只读行情模式不执行此升级，仍可查询尚未添加成交额列的旧表。

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
# Tick OHLC/成交额及主连映射测试使用本地临时 ClickHouse 18126（default / fixture-only），自动清理隔离数据库及账号。
QUANT_AMOUNT_INTEGRATION=1 node --import tsx --test plugins/vibe-quant/tests/tick-bars.test.ts plugins/vibe-quant/tests/continuous-bars.test.ts
```

测试覆盖交易时段偏移、午休、周末、跨夜、节假日前夜、未知日历、NaN 数据、搜索别名、引擎能力、数据库参数化、用户隔离、订阅上限、真实 ClickHouse 去重与引擎隔离，以及不落库模式实时合并、分页、缓存上限和独立采集。真实 ClickHouse 测试覆盖状态共享、用户隔离、同账号/跨账号并发订阅上限、租约接管后的旧实例写入拒绝、自动迁移重试及墓碑保留；受限账号验证行情仅 SELECT、状态仍可保存。

Tick 测试另外覆盖最近窗口完整读取、多 Tick 合并到达、纳秒精度、同时间不同序号、主连实际合约映射、跨夜交易日、窗口溢出、重试与重新回补、累计量异常、分钟对账、只含 Tick 的进程批次和失效租约拒绝写入。Python Tick 测试使用 pandas（TqSdk 运行依赖）。

实时行情验证需要使用者提供有效账号/Token/行情服务器；通过构建和隔离测试不代表已验证付费行情权限或生产逐笔数据完整性。断线重连按接口最近窗口回补 K 线和 Tick，不承诺重放窗口之外的中断数据。进程强杀可能丢失尚未入库的内存批次。

接口依据：[TqSdk](https://doc.shinnytech.com/tqsdk/latest/reference/tqsdk.api.html)、[Tushare 股票实时行情](https://tushare.pro/document/2?doc_id=372)、[Tushare 指数实时行情](https://tushare.pro/document/2?doc_id=403)、[PyTDX](https://github.com/rainx/pytdx)、[TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/)。

## Python 策略 SDK

`sdk/` 提供独立 Python `quant_sdk` 包，覆盖 IM／商品期货主连及股票的数据、回测和实时计算接口。安装、可运行示例、结果协议和当前边界见 [SDK 文档](sdk/README.md)。

## 策略管理

入口：侧边栏 **Vibe Quant → 策略**（`/plugins/vibe-quant/strategies`）。支持创建策略、编辑或导入 `.py` 脚本、下载脚本、保存草稿、发布固定版本、从旧版本恢复到草稿、停用新回测。

- **行情策略提示**：行情页每个自选标的下都有「策略提示」区域，只需选择策略和已发布版本；参数直接使用所选版本的参数，周期固定为添加时的图表周期（月线视图使用日线计算）。后台持续计算，K 线或分时图标记新的入场／离场，显示策略输出的当前止盈／止损保护线及实际合约价格。每条提示分别开关「计算」与「通知」；关闭通知不停止计算或图表更新。同一策略绑定不同标的时配置独立，支持移除提示。同一标的可绑定多个策略，每条提示独立运行并标明所属策略。策略页仅管理脚本、版本与回测，不再提供触发或通知配置。
- **历史记录**：行情中的策略提示使用独立的 `quant_signal_history` 表，不再复用普通回测。首次加入即从该标的、所选周期已有行情的最早时间全量计算，无需设置区间；随后持续处理实时行情。主连默认使用 `continuous_price`，按所选主连序列模拟信号与成交，页面标注「主连价格模拟」，不依赖实际主力合约历史映射，不计实际合约价差与换月成交成本；普通合约沿用实际合约价格。面板自动更新当前模拟持仓、已完成交易、入场／离场信号、收益与月／年统计。全量计算采用分页读取，并在计算期间缓冲实时事件。胜率仅统计已完成的 FIFO 平仓片段。移除策略提示会清空其历史、检查点和保护价快照，再次加入创建新记录并重新计算；暂停则保留历史。
- **图表价格与状态**：入场／离场标记使用源 K 线／报价时间定位，不使用网络送达时间。止盈止损来自 `ctx.set_risk_levels` / `RiskLevels`，未输出时显示空状态，历史交易保留入场至离场的保护价变化，行情图复用交易回放的分段止盈止损线与色块；持仓中的区间随实时数据更新，已平仓区间止于真实离场时间。旧版行情历史首次恢复时自动补算保护价快照。主连价格模拟直接使用主连价位；实际合约模式的当前保护线仍按同期观测价差投影，未投影的历史实际合约价格不直接画到主连图上。
- **实时计算配置**：每位用户最多保留 8 条策略提示；同一进程最多运行 8 条，其他提示等待空位。脚本执行沿用管理员权限，停用策略、归档、删除或撤销管理员权限都会停止监听。版本及参数在添加时固定，修改草稿不会更改已绑定版本。暂停／恢复保留检查点；更换版本时移除旧提示并重新添加。模拟持仓沿用默认资金 100 万、零费用和既有规则假设（期货乘数 200、保证金 12%；股票 100 股、T+1、全额资金），不在添加弹窗中要求填写回测参数。
- **通知渠道**：行情中的每条策略提示可配置前台 Toast、浏览器桌面通知。新建提示默认关闭通知，预选 Toast；开启后按该提示的渠道发送。旧记录未设置独立渠道时兼容读取历史策略通知配置，新的提示只使用自己的配置。Toast 通过宿主通知事件流在应用其他页面也能收到；桌面通知复用 Service Worker / Web Push，需宿主 `WEB_PUSH_PUBLIC_KEY`、`WEB_PUSH_PRIVATE_KEY`、`WEB_PUSH_SUBJECT` 及当前浏览器授权。未配置推送会禁用桌面通知的开启操作；页面内 Toast 和信号记录仍可使用。`notifications.channels` 按渠道 ID 保存，附加选项及未来渠道在编辑时保留，旧客户端省略整个字段时保留原设置。
- **触发与恢复**：SDK `target_position` 的新目标持仓增加触发入场、减少或归零触发离场，反向开仓产生两条；`risk_exit` 触发止损/止盈离场，自定义 `ctx.emit('entry'/'exit', symbol=..., side='long'/'short')` 也可通知。通知表示策略意图，不是实际账户成交；SDK 模拟成交器维护持仓以支持 `ctx.position` 和保护性退出，不连接交易账户。行情源确认收盘后的 K 线才交给策略，报价回调按实际接收数据计算。全量历史和重启补算会保存交易与信号，但不补发历史通知。信号 ID、检查点与租约写入 ClickHouse，前后台按稳定 ID 去重；最近 50 条信号可在页面查看。
- **运行与存储**：`quant_signal_monitors` 保存监听配置，`quant_signal_runtime` 保存运行租约，`quant_signal_checkpoints` 保存 SDK 检查点，`quant_signal_history` 独立保存交易、信号与增量汇总，`quant_signal_overlays` 保存当前保护价快照（写入同样受租约校验），启用插件时按需建表。删除配置先阻止所有旧进程写入，再同步清理相关表；清理中断由后台重试。自动重试间隔 30 秒，行情游标缺失会重新订阅并从检查点补算；数据或主力合约映射不足时展示异常，补齐数据后自动重试。旧预热配置仅兼容读取，不再限制计算起点。检查点超过 32 MiB 时显示异常并提示重新添加标的；SDK 升级导致检查点不兼容时也需重新添加。Python 与宿主之间用进程管道复用 SDK 数据路由，不传递浏览器会话、数据库或行情账户凭证。


- **归档与软删除**：列表可切换「当前策略 / 已归档 / 回收站」，策略右上角操作菜单支持归档、删除和恢复。删除只移入回收站，源码、参数、版本、回测与调优记录和结果均保留；恢复回到当前策略并保留原启用/停用设置。归档与回收站内的策略只读，不可保存、发布或发起新任务，已提交任务继续执行。操作需要最新 revision，对同库的所有已登录用户生效；旧记录缺少状态时视为当前策略，无需表结构迁移。HTTP `GET /strategies?status=active|archived|deleted|all` 默认只返回当前策略；`PATCH /strategies/:id/status` 接受 `{ "status": "archived", "revision": 1 }`，其中 status 也可为 `active`（恢复）或 `deleted`（软删除）。

- **策略编辑**：默认参数和回测参数共用表单 / JSON 编辑器，保留数字、文本、布尔和嵌套 JSON 类型，错误输入不能切换成有效表单或保存。Python 脚本支持带行号的语法高亮预览、编辑和复制；历史版本只读。入口无需配置，运行时自动选择本文件中唯一可实例化的 `Strategy` 子类（同一继承链选择最末级）；多个独立策略类需拆分为单独脚本。旧记录中的入口字段不再影响新回测。
- **脚本与版本解耦**：ClickHouse `quant_strategy_sources` 以 SHA-256 存放脚本正文，读写均校验哈希。`quant_strategies` 保存创建者、策略信息、草稿引用及已发布版本列表（固定正文哈希、默认参数和说明）。发布版本和更新 revision 在同一条记录中原子完成，已发布版本不可覆盖。保存草稿使用 revision 防止多个窗口相互覆盖；标签页内的未保存编辑可恢复。SDK 接口类仍随插件源码发布，不存入数据库。
- **每次运行都有记录**：ClickHouse `quant_strategy_runs` 固定用户、版本、数据引擎、时间区间、策略参数、资金、保证金、乘数、滑点、成交量参与率、手续费和基准，并保存队列状态、执行者与心跳。策略可调项集中在版本的默认参数中，脚本通过 `ctx.params` 读取；新回测先合并版本默认参数与本次覆盖值，再冻结完整参数，HTTP、页面和 Agent 工具保持一致。失败与取消同样保留，历史记录可用原参数创建新回测。
- **冻结数据**：执行前保存原始行情与 SDK Dataset，完成后保存结果和 SDK manifest；这些 JSON 存入 ClickHouse `quant_strategy_run_artifacts`；大产物在传输前使用带版本前缀的 gzip/base64 编码，并以单线程解析入库，降低数据库解析内存，表层仍使用 ZSTD。读取兼容旧明文 JSON，解压受大小上限约束，按运行 ID 和产物类型保持不可覆盖，并校验原始 JSON 的 SHA-256。与当前行情解耦，也不依赖某个服务进程的临时文件。导出包含版本源码、运行参数、Dataset、结果及 manifest。SDK manifest 记录 Python/SDK 版本和运行时源码哈希。
- **使用插件 venv**：调用现有 `ensurePython()`，运行 `<WORKSPACE_ROOT>/plugins/vibe-quant/.venv/bin/python`（Windows 为 `Scripts/python.exe`），要求 Python 3.10+。行情采集和回测共用环境，初始化/修复有文件锁。SDK 源码复制到本次运行目录并加入 Python 导入路径；用户额外依赖可安装到此 venv。
- **执行权限**：venv 是依赖环境，不是安全沙箱。只有管理员可提交运行服务器 Python 代码的回测；策略、版本、回测及调优结果在同一 ClickHouse 数据库内向所有已登录用户共享，支持共同编辑、发布和管理；`user_id` 仅记录创建者或任务提交者，编辑时保留原创建者，队列名额仍按提交者计算。已有记录立即共享，无需迁移用户 ID。子进程不继承数据库、行情账号、会话等环境变量。工作目录位于插件空间 `strategy-runs/`，产物入库后移除临时副本；脚本仍是具有宿主文件访问能力的受信任代码。
- **队列生命周期**：ClickHouse 的单条条件 INSERT 同时检查修订号或用户队列容量，并写入新状态；通过共享查询 ID 串行执行这些单条语句，不把跨请求读写当成事务。此机制沿用“同一台 ClickHouse 24.8+ 服务器”的要求，不支持多节点负载均衡。每进程同时认领一个与自身行情引擎匹配的任务，每用户最多三个未完成任务；两秒心跳用于取消和断线发现。普通回测和每次调参试验执行上限五分钟；取消先请求 SDK 停止，再终止不响应的进程组。服务异常退出后超时的记录标记为失败，不自动重复执行。插件停用会停止本进程运行。
- **结果与回放**：显示总收益/收益率、年化、最大回撤、夏普、交易笔数、最终权益、基准收益/年化、索提诺、卡玛、PF、净值曲线、月度/年度收益和交易表。交易表同时展示已平仓及未平仓记录，未平仓按已保存的开仓成交减去对应平仓数量还原，历史回测无需重新运行；部分平仓只展示剩余数量及其开仓手续费，离场与净收益留空。点击「查看入场」可定位原始入场 K 线，未平仓回放不绘制离场标记，止盈止损范围截止本次回测最后观测时间；交易笔数仍按已平仓片段统计，权益与总收益继续计入未平仓头寸的市值变化。交易回放与行情页共用完整的 `MarketChartPanel`，包含分时/多周期 K 线、指标及参数、划线、日期跳转和边缘分页，额外提供入场/离场定位。K 线通过 `useMarketBars` 和行情页相同的历史数据查询按需加载实际成交合约，使用该次回测的数据引擎，不受回测起止时间限制。成交标记仍取自回测记录，行情库后续修订不会改写成交结果。划线按回测、标的、周期保存，支持跨周期显示，与实时行情的划线隔离。打开时定位入场，入场/离场按钮只跳转视窗；拖至边缘继续双向加载，每页 200 根并保留视窗位置。冻结快照仍随回测保留、供导出和结果核验使用，不再限制图表可浏览的范围。

回测仅使用已经采集/导入的行情。所选日期可以超出已有数据范围，结束时间也可晚于当前时间；仅处理区间内已收盘的可用 K 线，不要求数据覆盖起止边界，没有可用行情时明确提示。默认 `actual_contract` 模式缺少历史主力映射或对应实际合约分钟线时明确失败，不替换成当前主力。显式选择 `continuous_price` 时，将所选主连作为保留原符号的合成期货，按主连价格模拟成交；原始行情目录不变，配置、Dataset、manifest 和结果页标明模拟口径，不计实际合约价差及换月成交成本，策略需支持此模式。单次最多十年（3,660 天）、500,000 根输入 K 线、24 个实际合约；单份产物最多 128 MiB。默认交易日历按实际行情和历史映射所需日期生成，使用 venv 中 `chinese-calendar` 的已公布节假日并排除周末，不因所选区间内无数据的未来日期要求额外日历；可在配置中提供完整日期到布尔值的交易所日历以覆盖特殊休市，未知日期失败。股票与期货交易规则需要根据品种明确填写；目录选择股票会填入 100 股、T+1、全额资金的默认配置。保证金和手续费都是回测假设，不代表交易所或经纪商当前标准。

数据模型与撮合范围沿用 [Python SDK](./sdk/README.md)。这里提供回测管理和实时信号监控，不接入实盘委托；支持固定版本上的 Optuna 参数优化，其他通知渠道可继续扩展。

5 分钟回测在冻结快照时，若有同标的的五根连续、已收完的 1 分钟 K 线，会优先以它们聚合信号 K 线，使信号与分钟成交使用同一价格序列；没有完整分钟数据时保留已存 5 分钟 K 线。缺分钟、跨休市或尚未收完的组合不会聚合，也不会改写行情表。原始快照和 Dataset 元数据记录派生来源、数量及替换数量，避免较短或不同口径的 5 分钟历史影响回测。

### Optuna 参数调优

点击策略页独立的 **调优参数** 按钮，或调用 `plugin_vibe_quant_backtest_optimize`。调优任务在独立面板查看，不出现在普通回测记录中；底层共用执行队列、固定版本、共享访问和交易规则，占用一个任务名额。

成功后自动创建一条新的、未发布的策略草稿：复制本次固定版本的源码和参数，仅替换参与搜索的参数；原策略的默认参数、已有草稿和已发布版本均保持不变。重复请求只返回同一份新草稿，不覆盖后续编辑。关闭页面不影响后台创建；如果保存失败，可在调优面板重试「生成调优草稿」。取消或失败的任务不自动生成草稿。

HTTP 使用 `GET/POST /strategies/:id/optimizations` 查询和提交，`/strategies/optimizations/:runId/result`、`/cancel`、`/draft` 获取结果、取消和重试保存草稿；普通 `/strategies/:id/runs` 仅返回普通回测并拒绝带 `optimization` 的提交。Agent 为兼容既有调用保留工具 ID，状态/结果中返回 `optimization_draft_id`。

`optimization` 配置示例（HTTP 与 Agent 共用）：

```json
{
  "search_space": {
    "fast": { "type": "int", "low": 2, "high": 10 },
    "slow": { "type": "int", "low": 15, "high": 60 },
    "stop_loss_pct": {
      "type": "float",
      "low": 0.005,
      "high": 0.03,
      "step": 0.005
    },
    "trailing_stop": { "type": "categorical", "choices": [false, true] }
  },
  "metric": "sharpe",
  "n_trials": 30,
  "timeout_seconds": 600,
  "seed": 42,
  "min_trades": 1
}
```

- 使用固定版本、同一份冻结 Dataset 和固定费用/滑点；每次试验启动新的 Python 进程，重置策略模块、实例和账户。未搜索的参数沿用回测参数。行情标的、周期、成交模式不参与搜索。
- 使用 Optuna 4.5.0 的 `TPESampler`，最多 200 次、搜索时间最多 3600 秒，先达到的限制结束搜索；单次试验最多 300 秒。默认种子 42；策略自身的随机源仍需策略自行固定。每次试验仅保留指标和参数，最佳训练试验保留原始完整结果及 manifest，不通过重跑替代最佳结果。
- 目标可选 `sharpe`、`total_return`、`annual_return`、`max_drawdown`、`sortino`、`calmar`、`profit_factor`。最大回撤取最小，其余取最大。交易不足或指标为 null 的试验不入选；策略错误记录为失败，继续其余试验。全部无效时整个任务失败。
- 可选 `validation_start`（UTC epoch 秒）将区间按时间拆分：之前用于搜索，之后只用最佳参数验证一次。验证重新初始化资金和仓位，之前的行情仅用于 SDK 历史预热，不调用交易回调；建议按完整交易日划分。验证另有 300 秒上限。未设置时明确标记为仅样本内；这是单次留出验证，不是 walk-forward，训练最佳值不代表泛化表现。
- 调优面板单独展示训练目标、验证指标、最佳参数和分页试验记录，完成后可直接打开新草稿。发布该草稿后可按普通流程创建回测。训练/验证的完整结果和 manifest 仍作为内部产物保存，`optimization` / `validation` 使用现有产物表，无需新表。
- 运行中通过状态消息显示试验进度；用户取消、插件停止或超时后尽可能保存最后完成的试验和最佳结果，状态仍为取消/失败。不会自动续跑崩溃任务。Agent 可使用现有 `backtest_status`、`backtest_cancel`；`backtest_result` 的 `optimization` 返回摘要，`section=optimization_trials` 每页 50 条。
- 插件 Python 环境按 requirements 指纹自动安装/更新 Optuna；离线部署的 wheel 包需包含更新后的 `worker/requirements.txt` 及其依赖。

验证真实 Optuna 和 Worker 产物保存：

```sh
<plugin-venv>/bin/python -B -m unittest discover -s plugins/vibe-quant/tests -p test_strategy_optimize.py -v
QUANT_OPTUNA_PYTHON=<plugin-venv>/bin/python node --import tsx --test plugins/vibe-quant/tests/optimization-worker.test.ts
node --import tsx --test plugins/vibe-quant/tests/optimization.test.ts plugins/vibe-quant/tests/quant-agent.test.ts
```

升级时先停止旧版本执行进程，再启用新版插件。首次启用自动创建上述 ClickHouse 表和 `quant_strategy_migrations`，读取旧 PostgreSQL 策略、版本、任务与 gzip 产物，分批复制并校验，完成后记录迁移指纹。中断可重试，已有 ClickHouse 记录不会被旧数据覆盖；旧 PostgreSQL 表保留为备份，正常策略业务不再读写这些表。旧的排队任务继续排队，迁移时仍在执行的任务标记失败，避免重复运行。宿主账号、插件配置和连接凭据仍由宿主管理。

所有服务均需对策略表有 SELECT、INSERT 权限；首次建表还需 CREATE TABLE，使用 `input()` 写入需 `CREATE TEMPORARY TABLE ON *.*`。开启“不写入行情数据”只影响行情表，策略及回测仍写入 ClickHouse。更换 ClickHouse 地址或数据库前需迁移这些表；旧 PostgreSQL 备份不包含升级后新保存的数据。

验证命令（集成测试使用本地 18124 ClickHouse 的独立数据库和 PostgreSQL schema 并自动清理，`QUANT_PYTHON` 可指定测试用插件 venv）：

```sh
node --import tsx --test plugins/vibe-quant/tests/strategies.test.ts plugins/vibe-quant/tests/strategy-storage.test.ts plugins/vibe-quant/tests/strategy-lifecycle.test.ts
QUANT_STRATEGY_INTEGRATION=1 node --import dotenv/config --import tsx --test plugins/vibe-quant/tests/strategies.test.ts plugins/vibe-quant/tests/strategy-storage.test.ts plugins/vibe-quant/tests/strategy-lifecycle.test.ts
# 加 QUANT_INTEGRATION=1 可连接既有测试约定的 localhost:18124 ClickHouse 验证真实快照查询。
```

策略回调支持返回 `RiskLevels`（或调用 `ctx.set_risk_levels`），每次计算的止盈止损快照写入 `risk_levels` 并通过 live 回调输出。回测和 paper 实时模拟会按执行 K 线开盘前的最新有效价格检查触发并自动平仓，计入成交量、T+1、手续费和滑点；monitor 仅输出计算结果。交易记录及行情回放显示离场原因、触发价格和对应的计算记录，并按入场信号绘制动态分段范围。开盘跳空按开盘价为基准，同根盘中两侧都触发时优先止损；OHLC 盘中成交注明时间精度。详见 [SDK 止盈止损接口](sdk/README.md#止盈止损范围与动态更新)。

## Quant Agent

插件启用后，聊天 Agent 列表提供 **Quant Agent**（`plugin:vibe-quant:quant-agent`），模型沿用宿主设置。Agent 定义位于 `mastra/agents/`，工具及共享执行上下文位于 `mastra/tools/`，由 `mastra/index.ts` 统一注册，不需要单独的模型凭据。可描述入场、离场、仓位和风控要求，让 Agent 创建或更新 Python 策略，再发布固定版本并提交历史回测。

所有工具 ID 均以 `plugin_vibe_quant_` 开头：

| 工具                                    | 用途                                                               |
| --------------------------------------- | ------------------------------------------------------------------ |
| `strategy_guide`、`instrument_search`   | 当前 SDK 文档、模板、权限和标的目录                                |
| `strategy_list`、`strategy_read`        | 共享策略列表、草稿及指定版本源码                             |
| `strategy_create`、`strategy_update`    | 创建草稿、按 revision 更新；支持启停，省略字段保留原值             |
| `strategy_versions`、`strategy_publish` | 查看版本摘要、固定当前草稿版本                                     |
| `backtest_start`、`backtest_list`       | 提交回测、分页读取历史记录                                         |
| `backtest_status`、`backtest_result`    | 等待进度、指标与说明、分页读取交易/委托/成交/信号/日志/权益/风险线 |
| `backtest_optimize`                     | 提交独立的 Optuna 调优任务，成功后创建新的策略草稿                 |
| `backtest_cancel`                       | 取消排队或运行中的回测                                             |
| `news_search`、`news_read`              | 搜索已采集资讯、读取正文及来源；采集关闭后仍可读取已有数据         |

典型流程是 `guide → list/read → create/update → publish → backtest_start → status → result`。创建策略只需 `name`、`source`，`parameters` 默认空对象；更新传 `strategy_id`、`revision` 和要改的字段，`source`、`parameters` 直接放在顶层，无需 `draft`。省略字段保留原值，`parameters` 如提供则整体替换。读取结果仍保留 `strategy.draft` 结构。

回测只需 `version_id`、`symbol`、`start`、`end`、`rules`，策略归属由版本自动确定；仍兼容可选 `strategy_id` 并校验归属。`backtest_start.parameters` 覆盖固定版本的同名参数。默认使用 1 分钟 K 线、初始资金 100 万、滑点 1 tick、参与率 10%、年化交易日 252，均为可覆盖的研究假设；乘数、保证金、手数、T+1 和手续费规则必须明确提供。`rules.fees.mode` 可选 `fixed`（按手／股固定金额）、`rate`（按成交额比例）、`combined`（两者叠加，省略时沿用历史口径）；页面新建回测默认选择固定模式，最低手续费与卖出税费在所有模式下生效。日期使用 UTC epoch 秒。工具参数保持简单，实际保存和回测仍执行后端校验；参数错误会返回具体字段或错误码。结果明细每页固定 50 条，用 `next_offset` 继续。数据缺失、执行错误和无成交保留为实际结果，不会被当作验证成功。

资讯查询无需策略指南：`news_search` 可直接留空查看最新资讯，或传 `query` 和可选行业名称/`industry` key，每页 20 条，用 `next_cursor` 继续。把返回的资讯 `id` 传给 `news_read.article_id` 读取正文；返回原文链接、来源、发布时间、采集时间及正文状态，不触发额外抓取。引用时区分发布时间与采集时间，说明正文缺失、截断或同步关闭的限制。

工具以当前消息作者的可信 `userId` 校验登录、记录创建者或任务提交者，每次执行检查账号和插件状态；策略和关联回测共享访问；Python 回测沿用 HTTP 接口的管理员限制，并重新查询账号角色。工具自动出现在后台工具配置中，可单独启停；聊天使用已有通用工具结果展示。中止工具等待会立即返回“用户中止了操作”；已提交的回测需通过 `backtest_cancel` 明确取消，提交过程中延迟写入的任务会在检测到中止后补充取消。数据库写入如已提交仍可能保留，恢复操作前应重新读取状态。

```sh
node --import tsx --test plugins/vibe-quant/tests/quant-agent.test.ts
# 使用上述隔离测试数据库和插件 Python 环境，验证工具到真实回测的完整链路
QUANT_STRATEGY_INTEGRATION=1 node --import dotenv/config --import tsx --test plugins/vibe-quant/tests/quant-agent.test.ts
```
