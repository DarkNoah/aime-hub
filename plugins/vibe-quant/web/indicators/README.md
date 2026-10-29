# 行情指标

主图脚本放在 `main/`，副图脚本放在 `sub/`，复杂指标的计算与配置放在同名目录。在 `registry.ts` 注册后，行情页会自动生成对应的显示菜单及参数表单。

内置 MA（SMA/EMA，默认三个周期 5/10/20）、MACD（默认 12/26/9）以及从图表中迁入的 VOL 成交量，默认显示。MA 的三个档位可分别设置周期和颜色，共用均线类型、价格来源和线宽；旧版本单根 MA 的周期与颜色保留到第三档。每个副图指标拥有独立面板，使用同一时间轴；隐藏时释放对应序列和空面板。更改指标不会重建 K 线图。

SMC 智能资金参照 stock-rl 的 `src/lib/smc` 移植，默认显示，入口为「主图指标 → SMC 智能资金」，右侧设置按钮打开分组参数弹窗。支持内部 / 波段 BOS、CHoCH，HH/HL/LH/LL，强弱高低点，订单块，EQH/EQL，FVG，日/周/月高低点，溢价/均衡/折价区及趋势蜡烛着色。52 项参考参数保留默认值，颜色支持独立不透明度；分时折线不挂载 SMC，切回 K 线恢复原设置。

计算、默认参数和绘图改编自 stock-rl 对 Smart Money Concepts [LuxAlgo] 的移植，© LuxAlgo，依据 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 发布该改编。这里调整了时间桶、参数表单和渲染器接入，保留来源署名。

## ORB Algo

入口为「主图指标 → ORB Algo」，默认关闭。根据用户提供的 **ORB Algo | Flux Charts**（© fluxchart，MPL-2.0）移植，原稿保存在 `main/orb/source.pine`。默认 30 分钟区间、Medium（1 次回踩）、Close 突破、Dynamic 止盈、HL2 EMA(9)、Balanced 止损和自适应止损；可切换 High / Low / Lowest（0 / 2 / 3 次回踩）、EMA 突破、ATR 止盈、EMA 4/9/13/20/34、Safer / Risky 止损。图中显示上下沿、Buy / Sell、TP 1–3、SL 和跨时段 Exit，可选 EMA。事件使用一体式五边形尖角标签，整边尖角指向对应 K 线高低点，Buy / Sell 也贴近信号 K 线，不再沿用原稿的 3 ATR 标签偏移；文字与尖端间距随图表缩放保持固定。状态面板和原稿模拟统计可分别关闭、调整位置；参数与显示状态本地保存。

ATR 使用 Wilder ATR(12)，种子为最初 12 根真实波幅均值。ATR 目标为入场价 ± 入场 ATR 的 0.75 / 1.5 / 2.25 倍；Dynamic 需 EMA 相对入场有利变化至少 0.20%，收盘反向穿过 EMA，后续目标还需相比上一目标有利移动至少 0.075%。保持原稿执行顺序：同根允许入场并触发 TP，每根最多一档 TP，触发 TP 时跳过 SL；TP 1 可将 SL 移至入场价，TP 3 终结。止损影线必须严格越过，触及相等不触发。新时段开始时，未结束信号以前一根收盘记录 Exit。High + EMA 保留原稿“突破失败后仍满足零次回踩而入场”的独立条件。

常规开盘时间以可配置的北京时间替代 Pine 的 `session.isfirstbar_regular`，默认 09:30，商品日盘可改为 09:00。须加载开盘前一根及开盘首根；保留原稿不处理已加载数据第 0 根的条件，EMA / ATR 仍包含该根。自定义时段默认关闭、10:00–11:00；支持跨午夜，时段仅用于识别新 ORB 的起点，不是信号截止时间。ORB 上下沿与信号持续到下一次起点。没有交易所会话元数据，节假日及常规/扩展交易时段以实际加载数据和设置为准。区间按 K 线起始时间取整根，非整除周期可能覆盖区间结束时刻之后的价格，与原稿相同；不大于 15 分钟的分钟 K 线可用，15 分钟本身也可用，其他周期显示提示。

“ORB 原稿模拟”完整保留原稿简化统计：分批比例默认 90% / 5% / 5%；触及过 TP 就记胜，未止盈且出现 SL / Exit 记负。收益使用绝对价差，残余仓位的 SL / Exit 一律扣减，因此有利的跨时段退出也会被扣成负收益；零权重目标也仍算触及 TP。这不是平台策略回测，不计费用、滑点、保证金、真实成交或换月成本，不能将其理解为可执行策略收益。无已判定胜负时显示“—”，不伪造胜率。

计算和统计使用全部已加载历史；绘图只显示最近 5,000 根内的区间起点与事件，并限制 500 条线、500 个标签。关闭历史只显示最新时段，统计不变。回放使用已揭示的 K 线，历史补齐或末根修订会重算并撤回失效事件。与原稿 `barstate.isconfirmed` 不同，行情接口没有确认标志，末根也参与计算，盘中信号可能变化；仅绘图，不发送策略通知。尚未完成 TradingView 同源逐根对照。

回归测试：`node --import tsx --test plugins/vibe-quant/tests/orb.test.ts plugins/vibe-quant/tests/indicator-renderer.test.ts`。

## RSI

入口为「副图指标 → RSI」，默认关闭。按用户提供的 Pine Script v6 移植，原稿保存在 `sub/rsi/source.pine`。默认 RSI(14)、收盘价来源及 SMA(14) 平滑线；提供无平滑、SMA、SMA + 布林带、EMA、SMMA / RMA、WMA、VWMA 七种选择。周期、来源、背离开关、布林带倍数、填充、线宽和颜色均可配置并本地保存。副图显示 70 / 50 / 30 参考线、紫色背景及超买 / 超卖渐变，数值保留两位小数，基础范围 0–100，布林带超出范围时自动扩展。

RSI 使用 Wilder RMA，等待完整周期的价格变化后输出，不用零填补预热值。保留原稿先判断下跌均值为零的顺序，因此连续持平时 RSI 为 100。SMA / RMA / WMA / VWMA 平滑等待完整有效窗口；EMA 从首个有效 RSI 初始化。VWMA 使用 K 线成交量，窗口成交量为零时留空。布林带使用总体标准差及默认 2 倍宽度。

常规背离默认关闭。开启后显示 RSI 更高低点 + 价格更低低点的 Bull，或 RSI 更低高点 + 价格更高高点的 Bear。左右各 5 根确认，严格保留原稿 `_inRange(plFound[1])` / `_inRange(phFound[1])` 的位移，所以相邻同类拐点间隔为 6–61 根；标记回画到确认前 5 根的拐点。历史补齐或末根行情修订会重算和撤回不再成立的信号。仅绘制标记，不发送策略通知；尚未进行 TradingView 同源逐根对照。

## 逻辑回归支撑阻力

入口为「主图指标 → 逻辑回归支撑阻力」，默认关闭，设置与显示状态沿用本地保存。根据用户提供的 **Support and Resistance Logistic Regression | Flux Charts** 移植，© fluxchart，改编文件遵循 [MPL-2.0](https://mozilla.org/MPL/2.0/)，原稿保存在 `main/logistic-sr/source.pine`。支持预测概率、有效触碰 R、突破 B、远线过滤、线型、线宽及独立线条 / 触碰文字配色；分时图暂不显示。R/B 仅作图表标记，不发送策略通知。

默认左右各 14 根确认拐点、目标有效触碰 3 次、概率阈值 0.7。RSI 与 ATR 使用 Wilder 平滑；实体大小取拐点 K 线，比较对象取确认 K 线的 ATR。保留原稿的 ±1 训练标签、固定偏置 1、学习率 0.008、`p + loss` 更新，以及将新拐点加入训练后再预测的顺序；损失用代数等价的稳定表达式避免 `log(0)`。这不是标准逻辑回归梯度，显示值也不是经验证的交易胜率。周期最小为 1，因为原稿允许的 0 无法用于 RSI / ATR。

影线严格穿过价位且收盘收回才计有效触碰；冷却只约束 R 标记（距离前次标记需大于 3 根），不影响训练计数。穿过后收盘等于或越过价位则终止该线；未突破线延伸到最新 K 线，距最新收盘超过 7 ATR 时可隐藏。显示最多 500 条线及 500 个标签，计算仍保留所有已加载拐点。拐点确认后回画至起点，概率在确认时固定；加载更早历史会重新训练。

行情接口没有 Pine 的收盘确认标志。本移植沿用现有指标的全量重算方式，末根 K 线的触碰、突破及拐点在盘中可能出现或撤回；与原稿仅在 `barstate.isconfirmed` 更新触碰 / 突破的实时行为有区别（[Pine bar states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/)）。尚未进行 TradingView 同源逐根对照。

## 成交量分布

成交量分布入口为「主图指标 → 成交量分布」，默认关闭。保留 stock-rl 的 30 个价格档、70% 价值区间、固定范围（5/15/30 分钟、1–5 小时、1/2/3/5 天）和默认隐藏当前未完成区间。横向分布占区间宽度的 42%，显示 POC、VAH、VAL、VWAP；POC 并列取较低价格档，价值区间从 POC 向成交量较大的邻档扩展，并列向上。设置沿用统一弹窗及本地保存。

数据源与 stock-rl 一致，使用 `node-tdx-market@0.2.1` 的通达信当日 / 历史分笔接口，股票走 `TdxClient`，期货走 `TdxExHqClient`。在授权的 `/volume-profile` 请求中按需补齐整日分页，保存到独立的 ClickHouse `tdx_trade_days`；当前日快照 15 秒缓存，图表每 30 秒刷新，已完成历史日复用持久化数据。K 线、盘口和 TqSdk 累计 Tick 的数据源及存储不变。价值区间内买入红色 `#e74c3cb3`、卖出绿色 `#27ae60b3`、中性灰色 `#95a5a6b3`，区间外浅灰 `#b6bdc680`，与 stock-rl 相同。方向沿用通达信，不通过 K 线或 TqSdk 快照推断；未知方向保留中性。期货时间到秒、股票到分钟，成交量单位沿用源接口（手）；它们不是交易所完整逐笔。

分笔按北京时间自然日归档，夜盘通过同款 stock-sdk 交易日历转换，涵盖周五夜盘及周六凌晨。主连按历史 `quotes.underlying` 映射，只显示映射覆盖完整且未跨换月的区间。指数、暂未接入的期权、缺失历史分笔、分页异常或存储权限不足都会显示原因，不回退成 K 线估算。原始分笔不发到浏览器，仅返回价格分档及价位。

`tdx_trade_days` 每行是一个标的的一天完整分页快照，分笔数组顺序保留同时间同价格同数量的重复记录；整行原子替换，版本按取数开始时间排序，旧请求晚完成不会覆盖新快照。旧版本由 ReplacingMergeTree 合并回收。当前日记录始终标为未终结，刷新失败不发布部分分页；跨日区间缺任一天即不绘制。行情只读模式只读取已保存分笔，不连接通达信或写入新分笔。插件参数中「分笔成交」独立配置证券 / 期货节点，不受主行情引擎选择影响。

固定锚点为北京时间 1970-01-01 00:00，按自然时间分段（不等同于期货交易日）。图表平移按可见范围加载，最多 60 天 / 240 段 / 25 万条快照；超限不返回截断的分布。实时每 30 秒刷新；隐藏指标、切标的或换范围时取消过期请求。分钟图支持将一根较粗 K 线拆为多个区间，日线只显示日范围，月线提示切换周期。历史整段分布仅供复盘，不能当作盘中当时已知信号。

## 定义接口

`types.ts` 中的 `IndicatorDefinition` 包含：

- `id`：稳定、唯一的保存标识。
- `type`：`main` 主图或 `sub` 副图。
- `name` / `description`：菜单名称与设置说明。
- `source`：可选的来源名称、链接，与计算用的“价格来源”参数分开。
- `parameters`：数字、选择、颜色、布尔、HH:MM 时间参数及默认值；支持 `group` 分组与颜色 `alpha` 不透明度，共用设置弹窗自动渲染。
- `validate`：可选的跨参数校验。
- `defaultVisible`：首次使用时是否显示。
- `requiresCandles`：只在 K 线视图显示，分时菜单禁用但保留已保存设置。
- `priceFormat` / `paneWeight`：价格精度类型、初始副图高度权重。
- `render(bars, parameters)`：计算与显示逻辑，返回具有稳定 ID 的折线/柱状图配置及数据。数据按时间升序，预热不足时省略 `value`，不要填入零值。
- `precision`：可选的指标数值精度。每个 plot 支持 `referenceLines` 及 `overlay`，用于自己的副图坐标系中的参考线、绘图、填充和基础数值范围。
- `renderOverlay(bars, parameters, duration, context)`：可选，返回线段、矩形、标签、蜡烛颜色、提示及可选固定位置状态面板（`dashboards`）。绘图横坐标使用当前历史窗口内的逻辑索引，不增加虚拟时间点。`context.volumeProfile` 提供异步加载的成交量分布。

`renderer.ts` 统一维护序列、零轴、独立面板和销毁逻辑。脚本不访问 React、DOM 或存储。每次行情更新、历史补齐或参数修改，基于当前已加载数据重新计算，当前未收盘 K 线也参与计算。

原生 `drawing-primitive.ts` 随图表平移、缩放和价格轴变化同步绘制。关闭 SMC 时卸载图层并恢复蜡烛原色，保留当前查看位置与手工划线。

输入 `Bar.time` 和输出数据点的 `time` 都使用原始 K 线起始时间。渲染器统一将分钟周期转换为结束时间，与主图 K 线坐标保持一致；脚本中无需偏移时间。

## 计算口径

MA 可选择开/高/低/收、HL2、HLC3、OHLC4；SMA 等待完整窗口，EMA 从已加载数据的首个价格初始化。MACD 默认采用 EMA，柱值为 MACD − Signal，不乘以 2，参照 [TradingView MACD 定义](https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/)。EMA 会受当前已加载历史起点影响，加载更早历史后重新计算，不承诺与其他平台逐点一致。

SMC 保留参考实现的收盘价突破、单次 pivot 突破、内部 5 根 / 波段 50 根确认、ATR(200)、订单块失效规则及 FVG 填补移除。实时 K 线被修订时重放历史，撤回失效信号。行情接口未提供收盘确认标志，图中信号不能当作已收盘确认事件。

多周期使用 UTC 起始时间，日/周/月按 Asia/Shanghai 日历聚合；月线不是固定 30 天。本次仅使用已加载 K 线，不另行请求日线补充；首个不完整高周期桶跳过，缺少上一完整周期或选择低于主图的周期时提示并跳过该图层。期货夜盘按自然日分桶，尚未引入交易日历映射。高周期 FVG 沿用参考实现的 Pine `lookahead_on` 合并，会随高周期行情修订而重绘。ATR 预热与周期数据不足提示显示在图表上方。未进行 TradingView 同源逐根对照。

## 本地保存

`vibe-quant:indicators:v1` 保存各指标的 `visible` 和 `parameters`，同一浏览器下跨标的、周期和刷新复用。隐藏指标不清除参数。损坏或过期字段回退到默认值；localStorage 不可用时保留当前页面设置，并通过 toast 提示未能保存。参数弹窗只有“应用参数”才写入，取消或关闭会丢弃草稿。

计算及配置回归测试：

```sh
node --import tsx --test plugins/vibe-quant/tests/indicators.test.ts plugins/vibe-quant/tests/smc.test.ts plugins/vibe-quant/tests/indicator-renderer.test.ts plugins/vibe-quant/tests/volume-profile.test.ts
node --import tsx --test plugins/vibe-quant/tests/logistic-sr.test.ts
node --import tsx --test plugins/vibe-quant/tests/rsi.test.ts
```

成交量分布的 ClickHouse 集成测试使用本机隔离测试实例 `127.0.0.1:18128`，以 `QUANT_PROFILE_INTEGRATION=1` 启用；每次创建随机测试库并在结束时清理。
