# Quant Strategy SDK · 0.1

独立的 Python 包 `quant_sdk`，提供 `data`、`backtest`、`live` 三个接口。策略只依赖 SDK；历史回测和实时计算共用 `Strategy`、`Context`、事件循环及模拟成交器。SDK 数据接口只提供数据；策略管理的后台回测由独立 Python 进程执行管理员提交的固定版本。

插件页面已提供脚本、版本、回测记录及交易行情回放。Optuna、通知 UI 和真实委托适配器尚未接入。

## 安装与离线验证

需要 Python 3.10+，SDK 无第三方运行依赖。在仓库根目录执行：

```bash
workspaces/plugins/vibe-quant/.venv/bin/python -m pip install -e plugins/vibe-quant/sdk
workspaces/plugins/vibe-quant/.venv/bin/python plugins/vibe-quant/sdk/examples/offline.py --output /tmp/quant-runs
```

示例用一份均线策略分别运行 IM 主连、商品期货主连和股票，检查回测与实时事件回放的信号、成交、交易记录、净值和指标完全相同。示例价格、保证金及费率均为测试输入，不代表当前交易所或券商标准。

## 同一份策略

```python
from quant_sdk import Strategy

class Trend(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params["symbol"], 60)

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        bars = ctx.data.history(bar.symbol, 60, count=20)
        if len(bars) < 20:
            return
        actual = ctx.data.resolve_contract(bar.symbol)
        size = ctx.data.instrument(actual).lot_size
        target = size if bars[-1].close > sum(b.close for b in bars) / 20 else 0
        ctx.orders.target_position(actual, target, reason="above_ma20")

    def on_roll(self, ctx, event, previous_contract):
        if previous_contract:
            ctx.orders.target_position(previous_contract, 0, reason="roll")
```

策略必须放在可读取的 `.py` 文件中，以便保存源码及校验指纹。恢复所需状态放入可 JSON 序列化的 `ctx.state`；普通实例属性不包含在检查点中。

| 接口                                           | 语义                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ctx.data.subscribe(symbol, duration=None)`    | 选择策略回调；`None` 同时接收该标的的 Bar 和 Quote。运输层订阅在 `client.stream(...)` 中建立。            |
| `history(symbol, duration, count, as_of=None)` | 仅返回已经收到并收盘的 K 线；拒绝读取运行时钟之后的数据。历史修订更新当前已知窗口，不重新触发过去的回调。 |
| `quote(symbol)` / `instrument(symbol)`         | 最新已观察报价／本次运行使用的交易规则。                                                                  |
| `resolve_contract(symbol)`                     | 股票返回自身；主连返回当时已观察到的真实合约；没有历史映射则报错。                                        |
| `ctx.orders.target_position(symbol, quantity)` | 以实际合约下达目标净持仓。股票数量为股，期货为手。                                                        |
| `ctx.emit(kind, **payload)`                    | 发出带稳定 ID 的业务信号，可附加 `stop_loss`、`take_profit`、`source_symbol` 等展示字段。                 |
| `ctx.account` / `ctx.position(symbol)`         | 本次模拟账户与仓位；monitor 不连接券商账户。                                                              |
| `ctx.params` / `ctx.state` / `ctx.now`         | 参数、可恢复状态、当前事件可用时间。时间统一为 UTC epoch 秒。                                             |

回调包括 `on_start`、`on_ready`、`on_bar`、`on_quote`、`on_roll`、`on_order`、`on_fill`、`on_stop`。预热只更新数据窗口；`on_ready` 在第一个有效计算事件前调用。首版 live 使用收盘 Bar 和 Quote，没有逐笔 Tick 策略接口。

```python
from quant_sdk import Dataset, RunConfig, backtest, live

data = Dataset.load("snapshot.json")
result = backtest.run(
    Trend(), data, params={"symbol": "KQ.m@CFFEX.IM"},
    config=RunConfig(initial_cash=1_000_000, slippage_ticks=1),
    output_dir="runs", on_event=lambda event: print(event),
)

# 使用完全相同的事件流验证计算及模拟成交一致性。
replayed = live.run(
    Trend(), iter(data.events), instruments=data.instruments,
    params={"symbol": "KQ.m@CFFEX.IM"},
    config=RunConfig(initial_cash=1_000_000, slippage_ticks=1),
    mode="paper", output_dir="runs",
)
```

`on_event` 接收 `{id, type, run_id, payload}`，type 为 `signal`、`order`、`fill`、`risk_levels`；运行结束由 `run()` 返回完整结果。信号 ID 包含策略代码、类、参数与触发事件；下游按 ID 去重。发生中止时返回 `status=cancelled`、`message=用户中止了操作`，错误则返回 `failed` 并保留记录。

## 止盈止损范围与动态更新

策略可以在回调中返回 `RiskLevels` 或其列表，也可调用 `ctx.set_risk_levels(...)`。回测和 `live(mode="paper")` 使用同一个保护性平仓执行器；`monitor` 输出计算结果，不产生模拟成交或真实委托。仅在 `ctx.emit(...)` 中附加同名字段不会启用保护性平仓。

```python
from quant_sdk import RiskLevels

# 下单时绑定本次入场信号；价格使用真实交易合约的坐标。
entry_id = ctx.orders.target_position(actual, 1, reason="trend_entry")
return RiskLevels(actual, stop_loss=price * 0.98,
                  take_profit=price * 1.04, entry_id=entry_id)

# 持仓期间每次计算都可更新。省略 entry_id 会更新该标的全部在持入场批次。
ctx.set_risk_levels(actual, stop_loss=trailing_stop, take_profit=target)
# None 表示清除对应价格；两个都为 None 则解除尚未触发的保护。
ctx.set_risk_levels(actual, stop_loss=None, take_profit=None)
```

`entry_id` 接受 `target_position` 返回的 ID（回测／paper 为订单 ID，monitor 为信号 ID），也可使用开仓成交的 `signal_id`；SDK 将其统一关联到入场信号。每次调用生成独立快照，包含 `id/event_id/time/symbol/entry_signal_id/stop_loss/take_profit`，保存在结果 `risk_levels`、检查点及实时回调中；相同时间的后一次计算覆盖前一次。前端按入场批次绘制动态分段范围，可以查看每次计算并定位行情。

成交规则随运行写入 manifest 的 `risk_model`：

- 执行 K 线开盘时使用当时已计算出的最新价格。收盘回调、成交回调或盘中 Quote 新计算的价格，从后续完整执行 K 线开始使用，不用新价格反推此前的高低点。
- 开盘已经越过止盈或止损时，按开盘价作为成交基准；否则检查该根高低价，按触发价格作为基准。同根同时触及两侧且无法判断先后时，保守地先执行止损。开盘已触及止盈的情形优先于随后盘中的止损。
- 触发后生成保护性市价平仓，只关闭对应入场批次，取消该标的未完成的普通开仓／反向目标委托。成交仍受共用的成交量参与率和股票 T+1 约束；剩余数量保持待平仓，后续按可成交 K 线开盘价执行。已触发的平仓不会被之后更新或清除的价格撤销。
- 平仓计入手续费、不利滑点和价格最小变动单位。滑点作为成交成本可使模拟成交价超出该根 OHLC；止盈也不承诺按目标价限价成交。主连策略必须为实际交易合约设置价格。
- OHLC 只能确定盘中触发所在 K 线：`exit_time_precision="bar"` 时，`exit_time` 使用收盘时刻记账，`exit_bar_time` 保留该根开盘时间供行情定位，不声称知道精确成交秒数。开盘成交为 `"open"`。

交易和离场成交保存 `exit_reason`（`stop_loss`／`take_profit`，或策略订单传入的 `reason`）、`risk_level_id`、`trigger_price`、`trigger_time`、`trigger_bar_time` 和 `trigger_time_precision`。触发后若因成交量或 T+1 延迟，触发信息保持不变，实际离场时间另行记录。行情回放标明离场原因、触发价格及对应的计算记录；等待平仓期间绘图保持触发时使用的范围，后续计算仍完整保存在结果中。

示例均线策略支持 `stop_loss_pct`、`take_profit_pct`、`trailing_stop`。风险平仓后等待下一次均线方向变化再开仓；策略可以自行设计重新入场条件。

## 连接已有 Vibe Quant 行情

HTTP 根路径为 `/api/plugins/vibe-quant/sdk`。沿用宿主登录和 Origin 检查，无额外公开鉴权入口。外部 Python 进程使用当前用户的会话 Cookie；POST/DELETE 必须携带服务端允许的前端 `Origin`。会话过期会报错，不绕过鉴权或跟随 HTTP 重定向。

```python
import json, os
from quant_sdk import HubClient, TradingCalendar, Instrument, Fees, live

client = HubClient(os.environ["QUANT_API_URL"], headers={
    "Cookie": os.environ["QUANT_SESSION_COOKIE"],
    "Origin": os.environ["QUANT_ORIGIN"],
})
# QUANT_API_URL 例如 http://localhost:3000/api/plugins/vibe-quant
# QUANT_ORIGIN 应为实际允许的前端 origin，例如 http://localhost:5173
calendar = TradingCalendar(json.load(open("calendar.json")))

def rules(symbol, metadata):
    if metadata["kind"] == "continuous":
        return Instrument(symbol, "continuous", metadata["priceTick"])
    if symbol.startswith("CFFEX.IM"):
        return Instrument(symbol, "future", metadata["priceTick"],
                          multiplier=200, margin_rate=0.15,
                          fees=Fees(per_unit=2, close_today_per_unit=5))
    raise ValueError(f"请配置 {symbol} 的交易规则")

# 先建立游标，再加载预热历史，防止历史加载期间丢掉事件。
with client.stream(["KQ.m@CFFEX.IM"], calendar=calendar, rules=rules) as source:
    warmup = client.snapshot(["KQ.m@CFFEX.IM"], start=history_start,
                             end=source.cutoff, calendar=calendar, rules=rules)
    result = live.run(Trend(), source, warmup=warmup, mode="monitor",
                      params={"symbol": "KQ.m@CFFEX.IM"})
```

上面的规则仅示范参数位置。正式使用须填入对应品种、合约及研究时段的交易规则。`TradingCalendar` 输入为覆盖所需日期的 `{"2026-10-16": true, "2026-10-17": false, ...}`；必须包含周末、节假日以及夜盘所属交易日。未知日期报错。日线默认以所属交易日 15:00 收盘，可显式配置 `daily_close`。SDK 不把自然日直接当作交易日。

完整命令示例见 `examples/hub.py`，规则文件样式见 `examples/rules.example.json`。账号信息通过环境传入，不写入运行清单。CLI 可选择 `backtest`、`monitor`、`paper`；Ctrl+C 会保存取消记录。`LiveRunner.cancel()` 或共享 `threading.Event` 可以中止持续轮询，网络阻塞最多等待客户端 timeout。

数据契约：

- 股票使用当前引擎的标准化股数成交量；IM 和商品主连使用 TqSdk 的 `KQ.m@...` 与真实交易合约。加权指数不当作主连合约。指数可配置为不可交易的信号或基准。
- 支持 1／3／5／15／30／60 分钟及日线；3 分钟由完整的三根 1 分钟 Bar 合成。`snapshot` 额外读取真实标的的 1 分钟 Bar，用于统一成交时钟。
- 历史数据来自已采集的 ClickHouse 数据；服务不隐式下载缺失行情。主连映射来自保存的历史报价；缺少起始映射或实际合约 K 线时拒绝生成回测输入，不使用“现在的主力合约”补过去。
- 历史快照是本次读取的已修订数据，包含日历和交易规则；保存后可重复回放。它不声称重建了当年每一次数据修订。复现实盘到达顺序应使用记录下来的 `events.jsonl`。
- 股票默认 100 股一手、T+1，具体板块或非 A 股规则可显式覆盖。期货必须提供乘数及保证金率。手续费支持按手／按金额、最低费用、平今差异、卖出税费；所有值写入记录。
- 服务端 SDK 订阅使用 120 秒租约，与自选共用总配额；轮询续约并保留已观察到的新旧主力合约，便于换月平旧仓。长时间运行可能需要更高的订阅配额，满额时明确报错。
- 历史加载须在租约和缓冲窗口内完成。服务重启、游标淘汰、切换到备用采集节点、租约过期都会报错，不能静默跳到最新行情。连接当前采集节点；多节点入口需保持会话路由。只读行情模式也可提供 live，但新增 SDK 租约表仍需状态库的读写权限。
- live 只确认源端在收盘之后再次发布的 Bar。不会用本机定时器把一份收盘前快照强行标为完整；休市前最后一根可能延后到后续源端更新。收到旧 Bar 的修订只更新历史，不重复下单。

服务端路由：

| Method | Path（相对于 `/sdk`）                                  | 用途                                 |
| ------ | ------------------------------------------------------ | ------------------------------------ |
| GET    | `/instruments/:symbol`                                 | 精确标的元数据，包括已保留的过期合约 |
| GET    | `/history?symbol=...&duration=60&after=...&before=...` | 前向分页 K 线，最多 1000 条          |
| GET    | `/contracts?symbol=...&from=...&to=...&after=...`      | 起始历史映射及后续观测分页           |
| POST   | `/sessions`，body `{symbols: [...]}`                   | 建立本人订阅、返回起始游标及初始报价 |
| GET    | `/sessions/:id/events?cursor=...`                      | 续约并读取 Bar／Quote 增量           |
| DELETE | `/sessions/:id`                                        | 释放本人租约                         |

## 成交与一致性边界

`monitor` 只发信号，不产生模拟成交，也不读取真实持仓。`paper` 和 `backtest` 使用同一个净持仓 FIFO 模拟器：下单之后的下一根可用执行 Bar 的开盘价，加不利方向滑点；默认执行周期 60 秒。以 Bar 成交量乘 `participation_rate` 限制成交量，检查资金、保证金、手数及 T+1。最低手续费按每次成交片段计算。

实时接收存在延迟时，已开始的 Bar 不可用于回填“过去的开盘成交”，订单可能等待再下一根 Bar。**历史收盘时钟回测与真实行情接收时钟不保证逐笔相同；对同一份录制事件的回测与实时回放才应相同。**

期货换月由策略明确平旧、开新；不会把旧仓改名。每日结算使用上一交易日最后观察收盘价作为代理，未接官方结算价。支持上述基于 Bar 的保护性平仓，未实现自动强平、涨跌停排队、真实盘口撮合、融券、公司行动／分红复权以及期权组合。运行结束按市值记录未平仓并取消挂单（包括尚未完成的风险平仓），未强制平仓。

## 记录、恢复和输出

每次运行创建独立目录，失败和取消也保留记录：

```text
<run_id>/
  strategy.py       # 策略模块源码
  manifest.json     # 参数、规则、时段、环境版本、源码和 SDK 指纹、成交口径
  dataset.json      # 回测固定输入；live 有 warmup.json
  events.jsonl      # 实际处理的事件序列
  outputs.jsonl     # 带 ID 的信号、订单、成交及止盈止损快照
  checkpoint.json   # 数据窗口、策略 state、账户与待发送输出
  result.json       # 完整结果
  status.json       # 运行状态
```

源码和运行数据以文件协议解耦，页面后续可以把同一套不可变内容转存对象存储／Git，而不用改变策略接口。SDK 不提供任意脚本沙箱；应在独立 Python worker 中运行自己信任的策略。外部模块、依赖锁文件和辅助资源仍需随策略项目管理，单个源码快照不能代替整个项目归档。

恢复使用 `LiveRunner.restore(Strategy(), checkpoint_path, ...)`，校验策略与 SDK 指纹。使用未处理的**连续事件流**续跑；检查点本身不会恢复已经断开的 HTTP 会话游标。录制事件可用 `Dataset.from_run(run_directory)` 重新回测，参数和时段在其 `metadata` 中。恢复分支目录只记录续跑部分，清单的 `resumed_from` 指向父检查点；完整分支审计需同时保留父目录。

检查点在发送信号前保存，其余默认每 5 秒更新。事件日志先于执行写入；未确认输出恢复后可能再次投递，下游以 ID 去重。进程崩溃恢复不是券商委托的 exactly-once 承诺。历史窗口和去重缓存有界；本次会话的完整净值、信号和交易结果仍保留在内存，建议按交易日用 `RunConfig.end` 分段运行，后续任务服务再负责长驻归档。

返回结构包含 `status/message/run_id/artifacts`、`metrics`、`equity_curve`、`monthly_returns`、`yearly_returns`、`orders`、`fills`、`trades`、`signals`、`risk_levels`、`logs`、`account`。交易记录保存实际 symbol、方向、数量、入／离场时间和价格、净损益、费用、对应 signal ID、离场原因与触发依据，供行情组件跳转和绘图。

| 指标                     | JSON 字段                                      |
| ------------------------ | ---------------------------------------------- |
| 总损益／总收益率／年化   | `total_pnl` / `total_return` / `annual_return` |
| 最大回撤／夏普／最终权益 | `max_drawdown` / `sharpe` / `final_equity`     |
| 交易笔数                 | `trade_count`（FIFO 平仓片段数）               |
| 基准收益／基准年化       | `benchmark_return` / `benchmark_annual_return` |
| 索提诺／卡玛／PF         | `sortino` / `calmar` / `profit_factor`         |

收益率使用小数；比率分母为零或缺少基准时返回 `null`。净值包含未实现损益，扣除已计费用；年度化收益以自然日 CAGR，夏普／索提诺以日末净值采样及 `annualization` 配置计算。月度和年度收益以各期末净值连续复利计算。短样本的年化值应结合 `metric_notes` 阅读。

## 验证

```bash
pnpm --filter @plugins/vibe-quant test
# 已准备本地隔离 ClickHouse 18124 时：
QUANT_INTEGRATION=1 pnpm --filter @plugins/vibe-quant test
```

覆盖统一策略回放、主连换月、股票 T+1、资金与保证金、手续费、部分成交、未来数据、历史修订、取消、恢复、信号投递、交易日历、HTTP 鉴权头及重定向、历史分页、会话隔离、游标缺口和 ClickHouse 共享订阅配额。测试不代表已连接用户的真实行情账号或交易账户。

### 策略管理中的入口识别

策略管理不提供入口类配置，`draft` 仅包含 `source` 和 `parameters`。回测工作进程在管理员授权执行脚本时，自动选择本文件中唯一可实例化的 `Strategy` 子类，同一继承链选择最末级。导入的类不参与自动选择；多个独立策略类会明确报错，需拆分为单独脚本。旧记录中的入口字段不再影响新回测，历史版本及已完成的回测产物保持原样。保存草稿和切换脚本预览不会执行 Python。
