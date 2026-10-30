# Quant Strategy SDK · 0.1

独立的 Python 包 `quant_sdk`，提供 `data`、`backtest`、`live` 三个接口。策略只依赖 SDK；内置历史回测和实时计算共用 `Strategy`、`Context`、事件循环及模拟成交器。策略管理另外支持 TqBacktest + TqSim 历史回测，沿用相同策略回调。后台回测由独立 Python 进程执行管理员提交的固定版本。

## 天勤历史回测

页面选择「天勤回测」，或通过 HTTP/Agent 提交 `backtest_engine="tqsdk"`。不传此字段的历史配置仍使用内置引擎。首版仅支持单个期货实际合约（例如 `CFFEX.IM2611`、`SHFE.rb2701`），可手工输入已到期合约；不支持主连映射、多合约、股票、点数模式或 Optuna 调优。基准只能留空或使用同一合约。需要在插件设置中配置天勤账号，并具备相应历史数据权限。

- 保留 `Strategy` 的 `on_start/on_ready/on_bar/on_quote/on_order/on_fill/on_stop`、`ctx.state`、`history`、目标净持仓、撤单及 `RiskLevels`。策略在同一实际合约上订阅周期；新订阅的历史窗口仅作预热，不补发历史交易信号。硬编码主连的策略仍须改成实际合约或读取 `ctx.params['symbol']`。
- TqApi + TqBacktest 推进行情，TqSim 决定委托、成交、资金、保证金和结算。订单使用对手价加 `slippage_ticks` 的限价（受涨跌停边界限制）；目标反向持仓先平再开，上期所/能源中心区分平今和平昨。等待撤单回报后再执行替代目标，竞态中已经发生的成交仍记入结果。
- `tq_options.commission_per_lot` 与 `margin_per_lot` 分别覆盖每手单边手续费、每手保证金（元）。留空优先继承插件 `tqSimCommissionPerLot` / `tqSimMarginPerLot`，插件未设置时使用天勤默认，任务创建时冻结配置、实际取值写入报告；不是历史费率表。`rules`、`participation_rate` 不用于天勤账户，服务端保存其规范占位值；界面只展示天勤实际规则。`instrument.margin_rate` 为初始化时的隐含比例，账户保证金始终取自 TqSim。
- K 线只在收盘后交给策略；预热窗口最多 2000 根/周期，运行中历史窗口沿用 SDK 上限。分钟收盘事件时间保留天勤微秒精度，成交图标按所属分钟定位。TqSim 不产生部分成交；保护单按收到的报价最新价触发，再由 TqSim 撮合，不能还原 K 线内部触发路径，不能与内置 OHLC 止损口径视为相同。
- 每笔成交保留原生委托/成交 ID；平仓按 FIFO 关联开仓信号，资金曲线来自原生账户。结果、行情快照、风险线、未平仓展示、交易图表和导出沿用现有格式。快照用于核对数据，不保证脱离天勤服务重新运行 TqSim 得到同样结果；一次性历史回测不支持检查点恢复；行情策略的持续模拟账户支持下述恢复机制。
- 每次任务有独立 TqSim 账户、15 分钟上限、50 万根 K 线与产物大小限制。凭证只从父进程管道传入，不进入任务参数、命令行、环境变量或回测产物；任务取消会终止整个进程组。

内置回测仍保留原有费用、成交量、主连模拟、点数回测及调优能力。

历史点数回测使用 `RunConfig(pnl_mode="points", point_cost=0)`。每个标的目标仓位归一为 `-1 / 0 / 1`，按价格点差累计盈亏，`point_cost` 为开仓、平仓各扣一次的点数成本；资金、乘数、保证金、成交量、T+1 及股票裸空限制不参与模拟，滑点与保护性止盈止损仍生效。此模式不能用于 `paper` 或 `monitor`。页面选择 `execution_model="points"` 会准备对应的历史快照，支持指数和不做换月映射的主连。结果 `pnl_unit="points"`，`equity_curve.equity` 从 0 开始表示累计点数，`benchmark_equity` 表示基准价格涨跌点数；资金收益率、年化和夏普等返回 `null`。

策略 `ctx.state` 支持 JSON 类型以及嵌套的 Python `date` / `datetime`；检查点使用带版本的类型编码，恢复后保留日期类型。其他自定义对象仍需由策略转换为可保存的数据。

插件页面已提供脚本、版本、回测记录、交易行情回放与内置引擎的 Optuna 调优。天勤回测只构造 TqSim 模拟账户。

## 行情策略的 TqSim 模拟引擎

行情「添加策略」可选 `simulation_engine="tqsdk"`。`symbol` 自动填入当前图表，可改为其他标的；`display_symbol` / `display_engine` 记录显示位置。例如在 `KQ.m@CFFEX.IM` 分别绑定 `CFFEX.IM2611`、`CFFEX.IM2612`，或在 `SZSE.000852` 绑定内置引擎的 `KQ.m@CFFEX.IM`。跨标的信号按时间显示并标明来源，不把其他标的的风险价格画在当前价格轴。天勤引擎仍仅支持单个期货实际合约。

- 初次启动使用 `TqApi + TqBacktest + TqSim` 回放历史，默认从最近十年前开始读取合约可用历史，可指定 `history_start`。随后切换到 `TqApi + TqSim`，沿用账户、持仓、委托与策略 `ctx.state`。信号来自确认的原生成交，历史计算期间不发送过期通知。
- 原生委托、成交、交易记录、账户摘要写入 ClickHouse `quant_signal_history`（摘要使用 `kind=summary`）；账户和策略检查点写入 `quant_signal_checkpoints`。先保存含待投递记录的检查点，再发布记录，以稳定 ID 去重。存储失败会重试同一批记录。
- 重启恢复已有账户和挂单；未发到 TqSim 的委托意图使用原 ID 重发，未确认撤单会再次撤销。停机期间行情只用于预热，不补造离线成交。历史转实时和重启不会人为执行一次日结；真实换日仍由 TqSim 处理。
- TqSdk 没有公开的完整状态保存接口，因此 `tq_persistence.py` 隔离适配内部状态并严格限定 `tqsdk==3.10.2`，不修改依赖包。升级 SDK 或策略运行时前需验证/迁移检查点；不兼容状态会明确报错，不能自动重置账户。
- 绩效直接读取 `TqSim.tqsdk_stat`；持续运行中通过天勤自身 `TqReport` 生成同口径指标，保留 `native_metrics` 和 `metrics_source`。年化/回撤/胜率采用天勤定义，胜率按平仓手数、毛盈亏统计，持平计为盈利。`profit_loss_ratio` 是天勤盈亏额比例，不伪装成内置 `profit_factor`；不支持的指标显示为空。
- 历史记录、账户曲线与交易图表沿用现有展示。交互式逐根重新计算目前仅支持内置引擎，天勤任务会明确提示不支持，避免用不同撮合器生成结果。此模式仅构造 TqSim，不连接实盘交易账户。

## 策略文件与版本控制

公开仓库只维护 SDK、回测/模拟执行引擎、接口、空白模板和行情指标的计算与展示。具体交易策略的源码、参数、描述、研究报告、专属测试及运行产物仅存放于本地忽略目录或策略数据库，不提交到 GitHub。

- `sdk/examples/` 整个目录为本地私有内容，包含已有策略文件及配套资料；新克隆不含这些文件。
- 新增私人研究文件优先放在仓库根目录的 `.local/quant-strategies/`；运行产物使用 `.quant-runs/` 或插件工作空间。
- `tests/test_*_strategy.py` 为具体策略的本地专属测试。公开的引擎测试只使用合成数据和测试桩。
- `sdk/templates/strategy.py` 是不含下单规则的公共模板。策略页面及 Agent 指南均读取此模板，不依赖私有文件。
- 行情指标代码 `web/indicators/` 保留版本管理。公共接口文档不内嵌具体交易规则。

这些私有路径同时由 `.gitignore` 和 `.dockerignore` 排除。忽略规则不会删除已经提交的历史副本；发现历史已包含私人策略时，应单独处理远端和 Git 历史。

## 安装与验证

需要 Python 3.10+，SDK 无第三方运行依赖。在仓库根目录执行：

```bash
workspaces/plugins/vibe-quant/.venv/bin/python -m pip install -e plugins/vibe-quant/sdk
workspaces/plugins/vibe-quant/.venv/bin/python -B -m unittest discover -s plugins/vibe-quant/tests -p test_strategy_sdk.py
```

引擎测试用合成行情和测试桩检查回测与实时事件回放的信号、成交、交易记录、净值和指标一致性。测试价格、保证金及费率不代表当前交易所或券商标准。

## 策略接口模板

```python
from quant_sdk import Strategy

class CustomStrategy(Strategy):
    def on_start(self, ctx):
        ctx.data.subscribe(ctx.params["symbol"], ctx.params.get("duration", 60))

    def on_bar(self, ctx, bar):
        if not bar.is_final:
            return
        # 在私有脚本或策略编辑器内编写自己的信号与风控逻辑。
        pass

    def on_stop(self, ctx, reason):
        # 可选清理逻辑；即使不使用 reason，重写时也必须接收这个参数。
        # 结束诊断用 ctx.log("research_diagnostics", reason=reason)，不能用 ctx.emit。
        pass
```

策略必须放在可读取的 `.py` 文件中，以便保存源码及校验指纹。恢复所需状态放入 `ctx.state`；普通实例属性不包含在检查点中。恢复时先调用新实例的 `on_start`，重新初始化参数、订阅和临时缓存，再加载检查点中的状态、持仓与待处理委托；初始化不会覆盖已保存的 `ctx.state`，已完成的 `on_ready` 不会重复执行。影响后续交易的累计状态必须放入 `ctx.state`，临时缓存应能从已恢复的数据窗口重建。

| 接口                                           | 语义                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ctx.data.subscribe(symbol, duration=None)`    | 选择策略回调；`None` 同时接收该标的的 Bar 和 Quote。运输层订阅在 `client.stream(...)` 中建立。            |
| `history(symbol, duration, count, as_of=None)` | 仅返回已经收到并收盘的 K 线；拒绝读取运行时钟之后的数据。历史修订更新当前已知窗口，不重新触发过去的回调。 |
| `quote(symbol)` / `instrument(symbol)`         | 最新已观察报价／本次运行使用的交易规则。                                                                  |
| `resolve_contract(symbol)`                     | 股票返回自身；主连返回当时已观察到的真实合约；没有历史映射则报错。                                        |
| `ctx.orders.target_position(symbol, quantity)` | 以实际合约下达目标净持仓。股票数量为股，期货为手。                                                        |
| `ctx.emit(kind, **payload)`                    | 在非预热的活动事件回调中发出带稳定 ID 的业务信号；不能在 `on_start` 或 `on_stop` 中调用。                 |
| `ctx.log(message, **fields)`                   | 写入结果 `logs`；可在初始化和结束阶段记录诊断信息。                                                      |
| `ctx.account`                                 | 本次模拟账户字典；monitor 不连接券商账户。                                                               |
| `ctx.position(symbol) -> int`                 | 有符号净持仓整数：正数为多仓、负数为空仓、0 为无持仓；股票单位为股，期货为手，点数模式为 -1/0/1。          |
| `ctx.params` / `ctx.state` / `ctx.now`         | 参数、可恢复状态、当前事件可用时间。时间统一为 UTC epoch 秒。                                             |

### 持仓数量与入场价格

内置和天勤回测的 `ctx.position(symbol)` 都返回整数，不返回 Position 对象、字典或 `None`。不要访问 `quantity`、`qty`、`net_quantity` 等属性，也不要逐个尝试这些字段，否则即使没有持仓、返回 `0` 时也会误报“没有净持仓字段”。直接读取并比较即可：

```python
quantity = ctx.position(symbol)
if quantity > 0:
    pass  # 持有多仓
elif quantity < 0:
    pass  # 持有空仓
else:
    pass  # 无持仓
```

SDK 当前没有公开的持仓均价读取接口；`ctx.position(symbol)` 上也没有 `average_price`、`avg_price` 或 `entry_price`。需要价格时，在 `on_fill(self, ctx, fill)` 中按实际成交维护 `ctx.state`，以支持检查点恢复。`fill` 是字典，常用字段如下：

| 字段 | 含义 |
| --- | --- |
| `fill["symbol"]` | 本次成交标的。 |
| `fill["price"]` | 本次实际成交价。 |
| `fill["quantity"]` | 有符号成交数量，买入为正、卖出为负；不等于成交后的净持仓。 |
| `fill["offset"]` | `"open"` 或 `"close"`，用于区分开仓和平仓。 |

单次单单位开仓可记录该笔开仓的 `fill["price"]`，平仓后清除。加仓、部分成交或部分平仓需要按数量及策略使用的成本口径维护成交台账；最后一笔成交价不能直接当作持仓均价，也不能用发出信号时的 K 线收盘价冒充实际入场价。

### 回调签名

所有回调均为同步实例方法，只需重写策略用到的方法，其余继承 `Strategy` 的空实现。重写时必须接收 runtime 传入的全部位置参数，即使某个参数没有使用也不能省略。

| 方法签名 | 调用时机与参数 |
| --- | --- |
| `on_start(self, ctx)` | 初始化参数、订阅和临时缓存。 |
| `on_ready(self, ctx)` | 预热结束后的第一个有效计算事件前调用。 |
| `on_bar(self, ctx, bar)` | 订阅的 K 线更新，`bar` 为 `Bar` 对象。 |
| `on_quote(self, ctx, quote)` | 订阅的报价更新，`quote` 为 `Quote` 对象。 |
| `on_roll(self, ctx, event, previous_contract)` | 主连映射变化；`event` 为 `Roll` 对象，`previous_contract` 为旧实际合约代码，首次映射时可为 `None`。 |
| `on_order(self, ctx, order)` | 委托更新，`order` 为字典。 |
| `on_fill(self, ctx, fill)` | 成交更新，`fill` 为字典。 |
| `on_stop(self, ctx, reason)` | 结束清理；`reason` 为结束原因字符串，正常结束通常是 `succeeded`，取消时是 `用户中止了操作`，失败时是错误信息。 |

**`on_stop` 不能写成 `def on_stop(self, ctx):`。** runtime 调用 `strategy.on_stop(ctx, reason)`，Python 还会自动传入 `self`，所以方法须接收三个参数。漏掉 `reason` 会报 `on_stop() takes 2 positional arguments but 3 were given`；无需清理逻辑时可省略整个方法。结束回调中不能下单或发出交易信号。

`on_stop` 执行时活动事件已清空，不能调用 `ctx.emit(...)`、`ctx.orders.target_position(...)` 或 `ctx.set_risk_levels(...)`。在这里调用 `ctx.emit` 也可能报 `Signals cannot be emitted during warm-up`，此时表示结束阶段没有活动事件，并非历史预热尚未完成。结束诊断应写入日志：

```python
def on_stop(self, ctx, reason):
    ctx.log("research_diagnostics", reason=reason,
            final_quantity=ctx.position(ctx.params["symbol"]))
```

预热只更新数据窗口；`on_ready` 在第一个有效计算事件前调用。首版 live 使用收盘 Bar 和 Quote，没有逐笔 Tick 策略接口。

```python
from quant_sdk import Dataset, RunConfig, backtest, live

data = Dataset.load(".local/quant-strategies/snapshot.json")
result = backtest.run(
    CustomStrategy(), data, params={"symbol": "KQ.m@CFFEX.IM"},
    config=RunConfig(initial_cash=1_000_000, slippage_ticks=1),
    output_dir=".quant-runs", on_event=lambda event: print(event),
)

# 使用完全相同的事件流验证计算及模拟成交一致性。
replayed = live.run(
    CustomStrategy(), iter(data.events), instruments=data.instruments,
    params={"symbol": "KQ.m@CFFEX.IM"},
    config=RunConfig(initial_cash=1_000_000, slippage_ticks=1),
    mode="paper", output_dir=".quant-runs",
)
```

`on_event` 接收 `{id, type, run_id, payload}`，type 为 `signal`、`order`、`fill`、`risk_levels`；运行结束由 `run()` 返回完整结果。信号 ID 包含策略代码、类、参数与触发事件；下游按 ID 去重。发生中止时返回 `status=cancelled`、`message=用户中止了操作`，错误则返回 `failed` 并保留记录。

## 止盈止损范围与动态更新

策略可以在回调中返回 `RiskLevels` 或其列表，也可调用 `ctx.set_risk_levels(...)`。回测和 `live(mode="paper")` 使用同一个保护性平仓执行器；`monitor` 输出计算结果，不产生模拟成交或真实委托。仅在 `ctx.emit(...)` 中附加同名字段不会启用保护性平仓。

```python
from quant_sdk import RiskLevels

# 下单时绑定本次入场信号；价格使用真实交易合约的坐标。
entry_id = ctx.orders.target_position(actual, target_quantity, reason=entry_reason)
return RiskLevels(actual, stop_loss=stop_price,
                  take_profit=target_price, entry_id=entry_id)

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

上面的目标仓位、价格和原因均由调用者的私有策略提供，SDK 不内置交易决策规则。

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
    result = live.run(CustomStrategy(), source, warmup=warmup, mode="monitor",
                      params={"symbol": "KQ.m@CFFEX.IM"})
```

上面的规则仅示范参数位置。正式使用须填入对应品种、合约及研究时段的交易规则。`TradingCalendar` 输入为覆盖所需日期的 `{"2026-10-16": true, "2026-10-17": false, ...}`；必须包含周末、节假日以及夜盘所属交易日。未知日期报错。日线默认以所属交易日 15:00 收盘，可显式配置 `daily_close`。SDK 不把自然日直接当作交易日。

本地连接脚本及规则文件请放在 `.local/quant-strategies/` 等忽略目录。账号信息通过环境传入，不写入运行清单。`LiveRunner.cancel()` 或共享 `threading.Event` 可以中止持续轮询，网络阻塞最多等待客户端 timeout。

数据契约：

- 股票使用当前引擎的标准化股数成交量；IM 和商品主连使用 TqSdk 的 `KQ.m@...` 与真实交易合约。加权指数不当作主连合约。指数可配置为不可交易的信号或基准。
- 支持 1／3／5／15／30／60 分钟及日线；3 分钟由完整的三根 1 分钟 Bar 合成。`snapshot` 额外读取真实标的的 1 分钟 Bar，用于统一成交时钟。
- 历史数据来自已采集的 ClickHouse 数据；服务不隐式下载缺失行情。主连映射来自保存的历史报价；缺少起始映射或实际合约 K 线时拒绝生成回测输入，不使用“现在的主力合约”补过去。
- 历史快照是本次读取的已修订数据，包含日历和交易规则；保存后可重复回放。它不声称重建了当年每一次数据修订。复现实盘到达顺序应使用记录下来的 `events.jsonl`。
- 股票默认 100 股一手、T+1，具体板块或非 A 股规则可显式覆盖。期货必须提供乘数及保证金率。手续费模式 `Fees.mode` 支持 `fixed`（成交手数／股数 × `per_unit`，忽略成交额费率）、`rate`（成交额 × `rate`，忽略每手／股金额）、`combined`（两者叠加）。省略模式时沿用 `combined`，兼容历史回测；页面新建回测默认选择固定手续费模式。开仓和平仓分别收取，平今使用对应的 `close_today_per_unit` / `close_today_rate`，`null` 沿用普通费用，`0` 免收该项。所有模式均保留最低费用 `minimum` 和额外的卖出税费 `sell_tax_rate`；所有值写入记录。
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

## 因子复用

期货因子通过 `from quant_sdk import Factor, load_factor` 使用。完整协议、策略示例和分析口径见 [FACTORS.md](FACTORS.md)。策略脚本用 `load_factor("已发布版本UUID")` 固定引用因子，并在回调中调用 `factor.value(ctx, bar.symbol, bar.duration)`，只读取当前时钟已收盘的历史。

可选的 `KronosFactor` / `kronos_forecast` 可将本地 Kronos 模型的独立预测路径转换为方向概率，安装、时间口径和验证方法见 [KRONOS.md](KRONOS.md)。
