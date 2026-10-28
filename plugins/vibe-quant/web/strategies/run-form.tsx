import { useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Button,
  JsonObjectEditor,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Switch,
  Textarea,
} from '@app/plugin-ui';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BacktestInput,
  BacktestRun,
  StrategyVersion,
} from '../../strategy-types';
import { InstrumentInput } from '../components/instrument-input';
import { errorText, parseObject } from './format';
import { FeeSettings } from './fee-settings';
import { VersionSelect } from './version-select';
import {
  defaultOptimization,
  OptimizationSettings,
} from './optimization-settings';
import {
  POINT_OPTIMIZATION_METRICS,
  type OptimizationConfig,
} from '../../optimization-types';

const localTime = (seconds: number) =>
  new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16);
export function RunForm({
  pluginId,
  strategyId,
  versions,
  primaryVersionId,
  mode = 'backtest',
  initial,
  onClose,
  onCreated,
}: {
  pluginId: string;
  strategyId: string;
  versions: StrategyVersion[];
  primaryVersionId?: string | null;
  mode?: 'backtest' | 'optimization';
  initial?: BacktestInput;
  onClose: () => void;
  onCreated: (run: BacktestRun) => void;
}) {
  const defaultVersion =
    versions.find((version) => version.id === primaryVersionId) ?? versions[0];
  const [config, setConfig] = useState<BacktestInput>(() =>
    initial
      ? { ...initial }
      : {
          version_id: defaultVersion.id,
          symbol: 'KQ.m@CFFEX.IM',
          duration: 60,
          start: Math.floor(Date.now() / 1000) - 7 * 86400,
          end: Math.floor(Date.now() / 1000),
          initial_cash: 1_000_000,
          slippage_ticks: 1,
          participation_rate: 0.1,
          annualization: 252,
          risk_free_rate: 0,
          benchmark_symbol: 'KQ.m@CFFEX.IM',
          parameters: defaultVersion.parameters,
          rules: {
            multiplier: 200,
            margin_rate: 0.12,
            lot_size: 1,
            t_plus_one: false,
            fees: {
              mode: 'fixed',
              per_unit: 0,
              rate: 0,
              minimum: 0,
              close_today_per_unit: null,
              close_today_rate: null,
              sell_tax_rate: 0,
            },
          },
        },
  );
  const [start, setStart] = useState(localTime(config.start));
  const optimize = mode === 'optimization';
  const [optimization, setOptimization] = useState(
    config.optimization ?? defaultOptimization,
  );
  const [space, setSpace] = useState(
    config.optimization
      ? JSON.stringify(config.optimization.search_space, null, 2)
      : '',
  );
  const [validationStart, setValidationStart] = useState(
    config.optimization?.validation_start
      ? localTime(config.optimization.validation_start)
      : '',
  );
  const [end, setEnd] = useState(localTime(config.end));
  const [params, setParams] = useState(
    JSON.stringify(config.parameters, null, 2),
  );
  const [calendar, setCalendar] = useState(
    config.calendar ? JSON.stringify(config.calendar, null, 2) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const points = config.execution_model === 'points';
  const native = !optimize && config.backtest_engine === 'tqsdk';
  const currentOptimization = {
    ...optimization,
    metric: points
      ? POINT_OPTIMIZATION_METRICS.includes(optimization.metric)
        ? optimization.metric
        : ('total_points' as const)
      : ['total_points', 'max_drawdown_points'].includes(optimization.metric)
        ? ('sharpe' as const)
        : optimization.metric,
  };
  const field = (key: keyof BacktestInput, value: unknown) =>
    setConfig((old) => ({ ...old, [key]: value }));
  const rule = (key: keyof BacktestInput['rules'], value: unknown) =>
    setConfig((old) => ({ ...old, rules: { ...old.rules, [key]: value } }));
  const numeric = (
    label: string,
    value: number | null,
    update: (v: number) => void,
    step = 'any',
  ) => (
    <Label className="grid gap-2 text-xs">
      {label}
      <Input
        type="number"
        step={step}
        required
        value={value ?? ''}
        onChange={(e) => update(e.target.valueAsNumber)}
      />
    </Label>
  );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const parsed = parseObject(params);
      const input = {
        ...config,
        backtest_engine: native ? 'tqsdk' : 'builtin',
        tq_options: native ? config.tq_options : undefined,
        optimization: optimize
          ? {
              ...currentOptimization,
              search_space: parseObject(
                space,
              ) as OptimizationConfig['search_space'],
              validation_start: validationStart
                ? Date.parse(`${validationStart}:00+08:00`) / 1000
                : undefined,
            }
          : undefined,
        parameters: parsed,
        start: Date.parse(`${start}:00+08:00`) / 1000,
        end: Date.parse(`${end}:00+08:00`) / 1000,
        ...(!native && calendar.trim()
          ? { calendar: parseObject(calendar) }
          : { calendar: undefined }),
      };
      const run = await pluginRequest<BacktestRun>(
        pluginId,
        `/strategies/${strategyId}/${optimize ? 'optimizations' : 'runs'}`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      onCreated(run);
      toast.success(
        optimize
          ? '已开始调优，完成后会创建新的策略草稿'
          : '已创建回测，参数和版本已固定',
      );
    } catch (e) {
      setError(errorText(e));
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent
        className="w-full sm:max-w-2xl gap-0 p-0"
        onEscapeKeyDown={(event) => {
          // Let the autocomplete dismiss its suggestions before closing the form.
          if (
            event.target instanceof HTMLElement &&
            event.target.matches('[role="combobox"][aria-expanded="true"]')
          ) {
            event.preventDefault();
          }
        }}
      >
        <SheetHeader className="border-b p-5">
          <SheetTitle>{optimize ? '调优参数' : '配置回测'}</SheetTitle>
          <SheetDescription>
            {optimize
              ? '选定版本和搜索范围，最佳参数将另存为新的策略草稿。时间按北京时间。'
              : initial
                ? '已复用该记录的参数，可修改后点击「开始回测」。时间按北京时间。'
                : '时间按北京时间，可选择内置回测或天勤模拟账户回测。'}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea
            className="min-h-0 min-w-0 flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div className="min-w-0 space-y-6 p-5">
              {!optimize && (
                <Label className="grid gap-2 text-xs">
                  回测引擎
                  <Select
                    value={config.backtest_engine ?? 'builtin'}
                    onValueChange={(value) => {
                      setConfig((old) => ({
                        ...old,
                        backtest_engine:
                          value as BacktestInput['backtest_engine'],
                        ...(value === 'tqsdk'
                          ? {
                              execution_model: 'actual_contract',
                              benchmark_symbol: null,
                            }
                          : {}),
                      }));
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="builtin">
                        内置回测 · 历史行情快照
                      </SelectItem>
                      <SelectItem value="tqsdk">
                        天勤回测 · TqBacktest + TqSim
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {native && (
                    <span className="font-normal leading-5 text-muted-foreground">
                      从天勤获取历史行情，使用本地模拟账户。首版支持单个期货实际合约；请先在插件设置中配置天勤账号。主连、股票和参数调优暂不支持。
                    </span>
                  )}
                </Label>
              )}
              <div className="grid min-w-0 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Label className="grid min-w-0 gap-2 text-xs">
                  脚本版本
                  <VersionSelect
                    versions={versions}
                    primaryVersionId={primaryVersionId}
                    disabled={busy}
                    value={config.version_id}
                    onValueChange={(id) => {
                      field('version_id', id);
                      setParams(
                        JSON.stringify(
                          versions.find((v) => v.id === id)!.parameters,
                          null,
                          2,
                        ),
                      );
                    }}
                  />
                </Label>
                <Label className="grid min-w-0 gap-2 text-xs">
                  信号周期
                  <Select
                    value={String(config.duration)}
                    onValueChange={(v) => field('duration', Number(v))}
                  >
                    <SelectTrigger className="w-full min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        [60, '1 分钟'],
                        [180, '3 分钟'],
                        [300, '5 分钟'],
                        [900, '15 分钟'],
                        [1800, '30 分钟'],
                        [3600, '1 小时'],
                        [86400, '日线'],
                      ].map(([v, label]) => (
                        <SelectItem key={v} value={String(v)}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
              </div>
              <div className="space-y-3">
                <Label className="grid gap-2 text-xs">
                  成交模式
                  <Select
                    disabled={native}
                    value={config.execution_model ?? 'actual_contract'}
                    onValueChange={(value) =>
                      field(
                        'execution_model',
                        value as BacktestInput['execution_model'],
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="actual_contract">
                        实际合约价格
                      </SelectItem>
                      <SelectItem value="continuous_price">
                        主连价格模拟
                      </SelectItem>
                      <SelectItem value="points">点数回测</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                {config.execution_model === 'continuous_price' && (
                  <p className="text-xs text-muted-foreground">
                    使用主连价格模拟成交，不计实际合约价差和换月成交成本。仅用于历史回测，策略需支持此模式。
                  </p>
                )}
                {points && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    按固定 1
                    单位计算多空价格点差，支持指数、股票和期货。忽略资金、保证金、合约乘数、成交量和
                    T+1；保留止盈止损与滑点。策略下单数量仅用于判断方向。
                  </p>
                )}
                <InstrumentInput
                  pluginId={pluginId}
                  value={config.symbol}
                  futuresOnly={native}
                  onChange={(symbol) => field('symbol', symbol)}
                  onSelect={(item) => {
                    const stock = item.kind === 'stock';
                    setConfig((old) => ({
                      ...old,
                      symbol: item.symbol,
                      benchmark_symbol: native ? null : item.symbol,
                      rules: {
                        ...old.rules,
                        multiplier: stock
                          ? 1
                          : item.symbol.includes('CFFEX.IM')
                            ? 200
                            : old.rules.multiplier,
                        lot_size: stock ? 100 : 1,
                        margin_rate: stock ? 1 : old.rules.margin_rate,
                        t_plus_one: stock,
                      },
                    }));
                  }}
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  {native
                    ? '信号与成交均使用所选实际合约；历史合约可手动输入，回测日期须位于合约存续期内。'
                    : points
                      ? '信号与成交使用所选标的价格，结果单位为点。主连不做实际合约映射。'
                      : config.execution_model === 'continuous_price'
                        ? '主连同时用于信号和模拟成交。'
                        : '主连产生信号，交易历史映射的实际合约。'}
                  {!points &&
                    !native &&
                    '股票数量单位为股，期货为手；商品期货请核对合约乘数。'}
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Label className="grid gap-2 text-xs">
                  开始时间
                  <Input
                    required
                    type="datetime-local"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </Label>
                <Label className="grid gap-2 text-xs">
                  结束时间
                  <Input
                    required
                    type="datetime-local"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </Label>
                <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                  {native
                    ? '历史数据由天勤提供，受账号权限与合约历史覆盖限制。'
                    : '日期可超出已有行情范围，回测使用区间内已收盘的可用 K 线，无数据时会提示。'}
                  结束时间须晚于开始时间，跨度最多十年。
                </p>
                {!points &&
                  numeric('初始资金（元）', config.initial_cash, (v) =>
                    field('initial_cash', v),
                  )}
                {points &&
                  numeric(
                    '单边成本（点，往返扣两次）',
                    config.point_cost ?? 0,
                    (v) => field('point_cost', v),
                  )}
                {numeric('滑点（最小跳动数）', config.slippage_ticks, (v) =>
                  field('slippage_ticks', v),
                )}
                {!points &&
                  !native &&
                  numeric(
                    '成交量参与率（0–1）',
                    config.participation_rate,
                    (v) => field('participation_rate', v),
                  )}
                {!native && (
                  <Label className="grid gap-2 text-xs">
                    基准标的（可留空）
                    <Input
                      value={config.benchmark_symbol ?? ''}
                      onChange={(e) =>
                        field('benchmark_symbol', e.target.value || null)
                      }
                    />
                  </Label>
                )}
              </div>
              {native && (
                <section className="space-y-3 border-t pt-5">
                  <h3 className="text-sm font-medium">天勤账户与撮合</h3>
                  <p className="text-xs leading-5 text-muted-foreground">
                    乘数与最小跳动取自合约信息。费用与保证金留空时沿用插件默认值，插件未设置时使用天勤默认值，结果会记录实际取值；不代表历史费率表。滑点在对手价上增加，TqSim
                    不模拟部分成交或成交量参与率。
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {(
                      [
                        ['commission_per_lot', '每手单边手续费（元）'],
                        ['margin_per_lot', '每手保证金（元）'],
                      ] as const
                    ).map(([key, label]) => (
                      <Label key={key} className="grid gap-2 text-xs">
                        {label}
                        <Input
                          type="number"
                          step="any"
                          min={key === 'commission_per_lot' ? 0 : undefined}
                          value={config.tq_options?.[key] ?? ''}
                          placeholder="使用 TqSim 默认值"
                          onChange={(e) =>
                            field('tq_options', {
                              ...config.tq_options,
                              [key]:
                                e.target.value === ''
                                  ? undefined
                                  : e.target.valueAsNumber,
                            })
                          }
                        />
                      </Label>
                    ))}
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    止盈止损按回放行情的最新价触发，再提交模拟委托。K
                    线回放无法还原完整盘中路径，结果可能与内置的高低价触发规则不同。
                  </p>
                </section>
              )}
              {!points && !native && (
                <section className="space-y-3 border-t pt-5">
                  <h3 className="text-sm font-medium">交易规则与费用假设</h3>
                  <p className="text-xs text-muted-foreground">
                    以下均为本次回测参数，请按交易品种填写。
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {numeric(
                      '合约乘数（股票固定为 1）',
                      config.rules.multiplier,
                      (v) => rule('multiplier', v),
                    )}
                    {numeric(
                      '保证金比例（0–1，股票固定为 1）',
                      config.rules.margin_rate,
                      (v) => rule('margin_rate', v),
                    )}
                    {numeric(
                      '最小交易单位',
                      config.rules.lot_size,
                      (v) => rule('lot_size', v),
                      '1',
                    )}
                    <Label className="flex items-center justify-between gap-3 text-xs">
                      T+1 限制
                      <Switch
                        checked={config.rules.t_plus_one}
                        onCheckedChange={(v) => rule('t_plus_one', v)}
                      />
                    </Label>
                  </div>
                  <FeeSettings
                    value={config.rules.fees}
                    onChange={(fees) => rule('fees', fees)}
                  />
                </section>
              )}
              <JsonObjectEditor
                label="策略参数"
                value={params}
                onChange={setParams}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                同名参数覆盖版本默认值，未填写的参数沿用默认值。
                symbol、duration 和 execution_model 由上方配置统一注入。
              </p>
              {optimize && (
                <OptimizationSettings
                  value={currentOptimization}
                  points={points}
                  onChange={setOptimization}
                  space={space}
                  onSpaceChange={setSpace}
                  validationStart={validationStart}
                  onValidationChange={setValidationStart}
                />
              )}
              <details className="border-t pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  统计与交易日历
                </summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {!points &&
                    !native &&
                    numeric(
                      '每年交易日数',
                      config.annualization,
                      (v) => field('annualization', v),
                      '1',
                    )}
                  {!points &&
                    !native &&
                    numeric('年化无风险利率', config.risk_free_rate, (v) =>
                      field('risk_free_rate', v),
                    )}
                  {native ? (
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      使用天勤交易日历、结算规则与 TqSim / TqReport
                      原生指标；年化、回撤及胜率均按天勤口径。
                    </p>
                  ) : (
                    <Label className="grid gap-2 text-xs sm:col-span-2">
                      覆盖交易日历（可留空，JSON 日期 → 布尔值）
                      <Textarea
                        className="min-h-28 font-mono text-xs"
                        value={calendar}
                        onChange={(e) => setCalendar(e.target.value)}
                        placeholder={'{"2026-10-19": true, "2026-10-20": true}'}
                      />
                      <span className="font-normal leading-5 text-muted-foreground">
                        默认使用插件内 chinese-calendar
                        公布的节假日并排除周末。特殊休市可提供完整区间日历；夜盘按下一交易日结算，未覆盖的日期会报错。
                      </span>
                    </Label>
                  )}
                </div>
              </details>
            </div>
          </ScrollArea>
          <div className="border-t p-4 space-y-3">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                <Play className="size-4" />
                {busy
                  ? '正在提交…'
                  : optimize
                    ? '开始调优并生成草稿'
                    : '开始回测'}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
