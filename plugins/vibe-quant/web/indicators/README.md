# 行情指标

主图脚本放在 `main/`，副图脚本放在 `sub/`，复杂指标的计算与配置放在同名目录。在 `registry.ts` 注册后，行情页会自动生成对应的显示菜单及参数表单。

内置 MA（SMA/EMA，默认三个周期 5/10/20）、MACD（默认 12/26/9）以及从图表中迁入的 VOL 成交量，默认显示。MA 的三个档位可分别设置周期和颜色，共用均线类型、价格来源和线宽；旧版本单根 MA 的周期与颜色保留到第三档。每个副图指标拥有独立面板，使用同一时间轴；隐藏时释放对应序列和空面板。更改指标不会重建 K 线图。

SMC 智能资金参照 stock-rl 的 `src/lib/smc` 移植，默认显示，入口为「主图指标 → SMC 智能资金」，右侧设置按钮打开分组参数弹窗。支持内部 / 波段 BOS、CHoCH，HH/HL/LH/LL，强弱高低点，订单块，EQH/EQL，FVG，日/周/月高低点，溢价/均衡/折价区及趋势蜡烛着色。52 项参考参数保留默认值，颜色支持独立不透明度；分时折线不挂载 SMC，切回 K 线恢复原设置。

计算、默认参数和绘图改编自 stock-rl 对 Smart Money Concepts [LuxAlgo] 的移植，© LuxAlgo，依据 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 发布该改编。这里调整了时间桶、参数表单和渲染器接入，保留来源署名。

## 定义接口

`types.ts` 中的 `IndicatorDefinition` 包含：

- `id`：稳定、唯一的保存标识。
- `type`：`main` 主图或 `sub` 副图。
- `name` / `description`：菜单名称与设置说明。
- `source`：可选的来源名称、链接，与计算用的“价格来源”参数分开。
- `parameters`：数字、选择、颜色、布尔参数及默认值；支持 `group` 分组与颜色 `alpha` 不透明度，共用设置弹窗自动渲染。
- `validate`：可选的跨参数校验。
- `defaultVisible`：首次使用时是否显示。
- `requiresCandles`：只在 K 线视图显示，分时菜单禁用但保留已保存设置。
- `priceFormat` / `paneWeight`：价格精度类型、初始副图高度权重。
- `render(bars, parameters)`：计算与显示逻辑，返回具有稳定 ID 的折线/柱状图配置及数据。数据按时间升序，预热不足时省略 `value`，不要填入零值。
- `renderOverlay(bars, parameters, duration)`：可选，返回线段、矩形、标签、蜡烛颜色和提示。绘图横坐标使用当前历史窗口内的逻辑索引，不增加虚拟时间点。

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
node --import tsx --test plugins/vibe-quant/tests/indicators.test.ts plugins/vibe-quant/tests/smc.test.ts plugins/vibe-quant/tests/indicator-renderer.test.ts
```
