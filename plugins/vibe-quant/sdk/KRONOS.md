# Kronos 概率因子（可选）

`quant_sdk.kronos_forecast()` 将 Kronos 多条独立预测路径转换成方向概率；
`KronosFactor` 可直接用于策略或包装为因子库脚本。普通 SDK 使用者不需要安装 PyTorch。

## 安装

在实际运行策略的 Python 环境中执行（平台环境通常为 `workspaces/plugins/vibe-quant/.venv`）：

```sh
python -m pip install -r plugins/vibe-quant/worker/requirements-kronos.txt
python plugins/vibe-quant/worker/setup_kronos.py --size mini
```

使用 Base 时安装到独立目录，保留原 mini 快照：

```sh
python plugins/vibe-quant/worker/setup_kronos.py --size base --target /absolute/path/kronos-base
```

运行前将 `QUANT_KRONOS_ROOT` 指向这个 Base 目录。Apple GPU 可在
`KronosFactor.forecast()` 或 `kronos_forecast()` 显式传入 `device='mps'`。

默认安装至该 Python 环境的 `share/quant-kronos`。可用 `--target /absolute/path`
安装到独立目录，再配置服务端环境变量 `QUANT_KRONOS_ROOT=/absolute/path`。
策略回测与实时进程只传递这个模型目录，不传递 Hugging Face 凭据或其他宿主环境变量。
使用独立目录时，仍须在实际 worker 的 Python 环境安装可选依赖。

安装器固定上游源码 commit，并解析、记录当次模型和 tokenizer 的精确 revision，
校验源码、配置与权重 SHA-256。目录必须是新的，禁止覆盖正在使用的 bundle。
策略运行只从本地加载，不下载模型、不修改第三方源码。部署到另一台机器时需复制
同一 bundle，并固定相同 Python/PyTorch/依赖版本；默认 Docker 镜像不包含这些大模型依赖。
因子库版本只冻结 Python 源码和参数，不打包模型权重；应在策略信号或报告中保存返回的
`model_fingerprint`，迁移时核对它。升级 bundle 后需开始新运行，旧检查点不能视作同模型续跑。

## 策略调用

```python
from quant_sdk import KronosFactor

# 在原策略的入场条件通过后执行；不要将模型对象放入 ctx.state。
forecast = KronosFactor().forecast(
    ctx, bar.symbol, bar.duration,
    lookback=128, horizon=1, samples=32, seed=0,
)
if forecast is None:
    return  # 预热不足或当天剩余交易时间不足
probability = forecast.bullish_probability if side > 0 else forecast.bearish_probability
ctx.emit('kronos_filter', accepted=probability >= 0.6, **forecast.to_dict())
if probability < 0.6:
    return
# 继续原策略的订单与保护线逻辑。
```

`horizon` 的单位是 K 线根数。短周期入场过滤可显式使用 `horizon=1`：
1 分钟策略预测下一分钟，5 分钟策略预测接下来的 5 个交易分钟；午休会按交易时段跳过。
`lookback=128` 是输入历史长度，与预测长度分别设置。省略 `horizon` 仍使用 SDK 默认值 6，
因此短周期策略应在参数中明确保存 1。比较不同年份时先固定预测长度、阈值和采样数，
保留指标所需的历史预热，再分别报告年度结果。

直接调用 `kronos_forecast(bars, ...)` 时，调用方负责只传入当前已知历史。
`KronosFactor.forecast()` 从 `ctx.data.history` 读取当前策略时钟的数据，并传递取消信号。
`KronosFactor().value(ctx, symbol, duration, metric='bullish_probability', ...)`
提供与普通因子一致的标量接口。因子库脚本可以定义一个包装类：

```python
from quant_sdk import Factor, KronosFactor

class DirectionProbability(Factor):
    def lookback(self, params):
        return params.get('lookback', 128)

    def compute(self, bars, params):
        return KronosFactor().compute(bars, params)
```

## 概率与时间口径

- 看涨概率 = `预测第 H 根收盘 / 当前收盘 - 1 > flat_return` 的路径比例。
  看跌使用 `< -flat_return`，其余为中性；三者总和为 1。`flat_return` 默认 0。
- 同时返回预期收益率、10/50/90% 收益率分位数、各步平均预测收盘、样本数、
  信号收盘时间、目标收盘时间、模型指纹和实际采样种子。收益率使用小数。
- [上游 predict 的 sample_count 会先平均路径](https://github.com/shiyu-coder/Kronos/blob/67b630e67f6a18c9e9be918d9b4337c960db1e9a/model/kronos.py)。
  本适配器使用重复历史的 `predict_batch(..., sample_count=1)`，每一行是一条独立路径，
  先计算每条路径的方向，再统计频率。不会用一条均值曲线冒充概率分布。
- 仅传入已收盘、同标的、同周期、顺序不重叠的历史。预测时间标签是 K 线开盘时间；
  默认支持 IM/IF/IH/IC 当日交易时段，跳过午休，当天余下 K 线不足时返回 `None`。
  其他市场（包括日线因子分析）必须传入交易日历给出的 `future_times` 开盘 epoch 秒序列，
  长度等于 horizon。绝不能用未来价格选择预测时间。不会假设周一至周五都交易。
- 没有真实成交额时填 0，不合成 `volume * price`。当前 SDK 不能保证所有数据源都有成交额。
- 采样种子由已知窗口、参数、模型指纹派生；缓存键包含全窗口 OHLCV/成交额和时间，
  数据修订、参数或权重变化都会使缓存失效。缓存限 128 条，只在当前进程内复用。
  默认 CPU，CUDA 或 Apple MPS 可显式选择（`device='mps'`）。采样会保存并恢复
  相应设备的随机数状态；不同设备/依赖版本不承诺逐位一致。
- 模型加载和推理失败会报错，不能退化成 50% 或默默放行。主机中止时会终止进程；
  `forecast(ctx, ...)` 还会在模型生成步骤检查取消信号。

## 效果验证

这是模型采样分布，不是经过校准的上涨概率，更不是止盈先于止损的概率。
固定 horizon、采样数、模型、阈值及成本后，将原策略和过滤版在相同冻结行情上重新运行，
比较净收益、回撤、交易数、胜率、PF、Sharpe，同时记录原候选机会上的方向准确率、
Brier 分数和 50% 基线。被拒绝机会是否允许再次入场必须提前规定。
应单独报告模型公开后区间；更早历史可能与预训练集重叠。未验证收益优势前不要替换主版本。
主连价格模拟仍不包含实际合约基差和换月成本。
