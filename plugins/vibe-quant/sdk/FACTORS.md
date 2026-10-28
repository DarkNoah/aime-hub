# Python 期货因子

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
