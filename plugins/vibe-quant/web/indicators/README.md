# 行情指标

主图脚本放在 `main/`，副图脚本放在 `sub/`，一个指标一个 TypeScript 文件。在 `registry.ts` 注册后，行情页会自动生成对应的显示菜单及参数表单。

内置 MA（SMA/EMA，默认 20 周期）、MACD（默认 12/26/9）以及从图表中迁入的 VOL 成交量，默认显示。每个副图指标拥有独立面板，使用同一时间轴；隐藏时释放对应序列和空面板。更改指标不会重建 K 线图。

## 定义接口

`types.ts` 中的 `IndicatorDefinition` 包含：

- `id`：稳定、唯一的保存标识。
- `type`：`main` 主图或 `sub` 副图。
- `name` / `description`：菜单名称与设置说明。
- `source`：可选的来源名称、链接，与计算用的“价格来源”参数分开。
- `parameters`：数字、选择、颜色、布尔参数及默认值；共用设置弹窗自动渲染。
- `validate`：可选的跨参数校验。
- `defaultVisible`：首次使用时是否显示。
- `priceFormat` / `paneWeight`：价格精度类型、初始副图高度权重。
- `render(bars, parameters)`：计算与显示逻辑，返回具有稳定 ID 的折线/柱状图配置及数据。数据按时间升序，预热不足时省略 `value`，不要填入零值。

`renderer.ts` 统一维护序列、零轴、独立面板和销毁逻辑。脚本不访问 React、DOM 或存储。每次行情更新、历史补齐或参数修改，基于当前已加载数据重新计算，当前未收盘 K 线也参与计算。

## 计算口径

MA 可选择开/高/低/收、HL2、HLC3、OHLC4；SMA 等待完整窗口，EMA 从已加载数据的首个价格初始化。MACD 默认采用 EMA，柱值为 MACD − Signal，不乘以 2，参照 [TradingView MACD 定义](https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/)。EMA 会受当前已加载历史起点影响，加载更早历史后重新计算，不承诺与其他平台逐点一致。

## 本地保存

`vibe-quant:indicators:v1` 保存各指标的 `visible` 和 `parameters`，同一浏览器下跨标的、周期和刷新复用。隐藏指标不清除参数。损坏或过期字段回退到默认值；localStorage 不可用时保留当前页面设置，并通过 toast 提示未能保存。参数弹窗只有“应用参数”才写入，取消或关闭会丢弃草稿。

计算及配置回归测试：

```sh
node --import tsx --test plugins/vibe-quant/tests/indicators.test.ts
```
