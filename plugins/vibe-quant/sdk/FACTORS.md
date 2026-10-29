# Python 期货因子

可选模型因子见 [Kronos 概率因子](KRONOS.md)：使用本地固定权重，将独立预测路径转换为看涨/看跌概率。

因子库与策略库一样保存在 ClickHouse，共享给已登录用户。修改、发布及运行因子需要管理员权限，Python 进程隔离不等于安全沙箱。因子分析目前支持期货实际合约和 `KQ.m@` 主力连续的日线。

```python
from quant_sdk import Factor

class MovingAverageDistance(Factor):
    def lookback(self, params):
        return int(params.get('window', 20))

    def compute(self, bars, params):
        average = sum(bar.close for bar in bars) / len(bars)
        return bars[-1].close / average - 1 if average else None
```

- 每个脚本只定义一个具体 `Factor` 子类。`lookback(params)` 返回 1–500 的整数，默认 100。
- `compute(bars, params)` 收到同一合约、同一周期的已收盘 `quant_sdk.Bar` 元组，按时间升序排列，长度恰为 lookback。字段包括 open/high/low/close/volume/time/end_time/trading_day/symbol/duration。
- 返回有限数值或 `None`；历史条数不够时 SDK 自动返回 `None`。不要返回字符串、布尔值、NaN 或无穷值。
- compute 应为纯函数。不要依赖调用次数、可变实例状态、当前机器时间或外部文件，不访问网络、环境变量或进程；仅使用标准库和 quant_sdk。分析和策略使用相同 evaluate 路径。
- 因子默认参数随版本固定。修改草稿不会更改已发布版本，停用也不会使已有固定版本失效。

## 策略调用

先发布因子，取得版本 ID。使用 `load_factor("完整版本ID")` 字面量调用，主机自动收集该版本及其依赖的源代码与默认参数，写入本次运行的 `factor-library.json`，并保存在回测产物与 manifest.factor_versions 中。不支持动态拼接、变量版本 ID、别名函数名或隐式最新版本。因子间引用也使用同样语法，不允许循环依赖。

```python
from quant_sdk import Strategy, load_factor

class FactorStrategy(Strategy):
    def on_start(self, ctx):
        self.factor = load_factor("替换为已发布版本ID")
        ctx.data.subscribe(ctx.params['symbol'], ctx.params.get('duration', 86400))

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        value = self.factor.value(ctx, bar.symbol, bar.duration, window=20)
        if value is not None:
            ctx.log("因子值", value=value)
            # 根据用户指定的交易和风控规则处理 value。
```

`value` 从 `ctx.data.history` 读取当前策略时钟可见的已收盘 K 线。未覆盖的参数使用版本默认值，history_limit 不得小于 lookback；须订阅对应周期并提供足够预热历史。兼容内置回测、调优、TqSdk 回测、实时监控与历史回放。独立 SDK 运行时需自行提供相同格式的因子快照，或将 Factor 类直接放进脚本并实例化。

## 因子分析

至少三个合约，合约数不小于分组数。仅分析已有行情，不自动下载或回填缺失数据。日线按策略 SDK 的中国交易日历和 15:00 收盘口径过滤未结束交易日，最多预热 500 条。

- 信号为当日收盘因子；远期收益为下一交易日开盘至持有 H 个交易日后的开盘价格变化。
- IC 为每日横截面 Pearson 相关系数，Rank IC 对并列值取平均排名；衰减展示不同持有期。IC 序列使用重叠窗口，t 值未修正自相关，缺少有效样本时显示空值。
- 调仓从第一个共同有效信号日开始每 H 个交易日一次，不重叠。分组按方向调整后的因子从低到高排序，组内等权；并列值按合约代码排序。未来行情缺失时整期跳过，不能按未来是否有行情筛选合约。
- 多空组合是 50% 做多最高组、50% 做空最低组，总名义敞口为 1。收益复利累计，年化按 252 个交易日与有效持有区间估计。净值在调仓点采样，回撤不含持有期内及盘中波动。换手率为两次等权目标权重差绝对值之和的一半，不计首次建仓，也不是考虑价格漂移后的实际成交换手。
- 分析不计手续费、滑点、保证金和主连换月执行成本，固定合约池未纠正幸存者偏差。结果是因子研究指标，不等于可执行策略回测。
- 分析记录保留当次源码、参数、哈希、配置和结果；行情使用当时最新修订的库内数据，再次运行可能因行情修订而变化。

## 分组与内置库

因子库以树状分组组织。未指定 `group_id` 的新因子及旧因子归入“未分类”。“未分类”、WorldQuant Alpha101、国泰君安、Qlib Alpha158、Qlib Alpha360 是固定分组，不能删除、改名或移动。管理员可创建多级自定义组、重命名和移动组；删除组及其子组后，因子归入“未分类”，代码、版本和报告保留。分组修改使用整个树的 revision 防止并发覆盖。

四套内置库包含 101 / 191 / 158 / 360 个公式。内置定义只读，已有 v1 固定版本，可直接分析，也可复制为自定义因子。详情展示原始公式、所需数据、预热条数、来源和原文歧义采用的解释。`factor_read` 支持 group_id/query 筛选，列表最多返回 100 条并返回 total/truncated；先按组缩小范围，再读取具体因子。

内置时序因子继承 `quant_sdk.alpha.ExpressionFactor`，适用前述 `value()` 调用。横截面因子需要固定合约池同日数据，不能以单合约时序排名替代；宿主分析会调用 `evaluate_panel`，独立 SDK 用法：

```python
factor = load_factor("已发布的横截面因子版本ID")
# histories 的每个值都是按时间递增、只包含当前时钟已收盘日线的 Bar 列表。
# 不要传入未来数据。每个所选合约每天只能有一根日线。
values = factor.evaluate_panel(histories)  # pandas.DataFrame：交易日 × 合约
latest = values.iloc[-1]
```

当前分析数据连接器提供 OHLCV 及已有成交额；不会自动补齐 VWAP、行业分类、市值、基准指数或 MKT/SMB/HML。SDK Bar 可显式接收对应扩展字段，缺少公式所需数据会报错，不使用 OHLC 均价等代理。WorldQuant ADV 按论文取平均成交额。递推 SMA 使用最近 500 根固定预热窗口，首个有效输入初始化，标量与面板使用同一窗口。

完整来源、运算约定、勘误和验证范围见 [内置因子说明](../server/factors/builtins/README.md)。
