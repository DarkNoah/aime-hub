import { useEffect, useState } from 'react';
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
import { Play, Search } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BacktestInput,
  BacktestRun,
  StrategyVersion,
} from '../../strategy-types';
import type { Instrument } from '../../shared';
import { errorText, parseObject } from './format';
import { FeeSettings } from './fee-settings';
import {
  defaultOptimization,
  OptimizationSettings,
} from './optimization-settings';
import type { OptimizationConfig } from '../../optimization-types';

const localTime = (seconds: number) =>
  new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16);
export function RunForm({
  pluginId,
  strategyId,
  versions,
  mode = 'backtest',
  initial,
  onClose,
  onCreated,
}: {
  pluginId: string;
  strategyId: string;
  versions: StrategyVersion[];
  mode?: 'backtest' | 'optimization';
  initial?: BacktestInput;
  onClose: () => void;
  onCreated: (run: BacktestRun) => void;
}) {
  const [config, setConfig] = useState<BacktestInput>(() =>
    initial
      ? { ...initial }
      : {
          version_id: versions[0].id,
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
          parameters: versions[0].parameters,
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
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Instrument[]>([]);
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedVersion = versions.find((v) => v.id === config.version_id);
  const versionLabel = selectedVersion
    ? `v${selectedVersion.number} · ${selectedVersion.note || selectedVersion.source_hash.slice(0, 8)}`
    : '';
  useEffect(() => {
    if (!search.trim()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      pluginRequest<Instrument[]>(
        pluginId,
        `/instruments?q=${encodeURIComponent(search)}`,
        { signal: abort.signal },
      )
        .then((rows) => {
          setMatches(rows.filter((item) => item.kind !== 'option'));
          setSearchError('');
        })
        .catch((e) => {
          if (!abort.signal.aborted) setSearchError(errorText(e));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [pluginId, search]);
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
        optimization: optimize
          ? {
              ...optimization,
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
        ...(calendar.trim()
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
      <SheetContent className="w-full sm:max-w-2xl gap-0 p-0">
        <SheetHeader className="border-b p-5">
          <SheetTitle>{optimize ? '调优参数' : '配置回测'}</SheetTitle>
          <SheetDescription>
            {optimize
              ? '选定版本和搜索范围，最佳参数将另存为新的策略草稿。时间按北京时间。'
              : initial
                ? '已复用该记录的参数，可修改后点击「开始回测」。时间按北京时间。'
                : '时间按北京时间，使用所选成交模式的一分钟 K 线模拟成交。'}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea
            className="min-h-0 min-w-0 flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div className="min-w-0 space-y-6 p-5">
              <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Label className="grid min-w-0 gap-2 text-xs">
                  脚本版本
                  <Select
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
                  >
                    <SelectTrigger
                      className="w-full min-w-0"
                      title={versionLabel}
                    >
                      <SelectValue className="min-w-0 flex-1 text-left">
                        <span className="truncate">{versionLabel}</span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      className="w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]"
                    >
                      {versions.map((v) => (
                        <SelectItem
                          key={v.id}
                          value={v.id}
                          className="[&>span:last-child]:min-w-0"
                        >
                          <span className="min-w-0 whitespace-normal break-words">
                            v{v.number} · {v.note || v.source_hash.slice(0, 8)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                    </SelectContent>
                  </Select>
                </Label>
                {config.execution_model === 'continuous_price' && (
                  <p className="text-xs text-muted-foreground">
                    使用主连价格模拟成交，不计实际合约价差和换月成交成本。仅用于历史回测，策略需支持此模式。
                  </p>
                )}
                <Label className="grid gap-2 text-xs">
                  信号标的
                  <Input
                    required
                    value={config.symbol}
                    onChange={(e) => field('symbol', e.target.value)}
                    placeholder="KQ.m@CFFEX.IM / KQ.m@SHFE.rb / SSE.600000"
                  />
                </Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    aria-label="搜索行情标的"
                    className="pl-9"
                    placeholder="从行情目录搜索，例如 IM、螺纹钢"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {search && (
                  <div className="rounded-md border">
                    <ScrollArea className="max-h-40">
                      {matches.slice(0, 12).map((item) => (
                        <button
                          type="button"
                          key={item.symbol}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-accent"
                          onClick={() => {
                            const stock = item.kind === 'stock';
                            setConfig((old) => ({
                              ...old,
                              symbol: item.symbol,
                              benchmark_symbol: item.symbol,
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
                            setSearch('');
                            setMatches([]);
                          }}
                        >
                          <span>{item.name}</span>
                          <span className="font-mono text-muted-foreground">
                            {item.symbol}
                          </span>
                        </button>
                      ))}
                      {!matches.length && (
                        <p className="p-3 text-xs text-muted-foreground">
                          {searchError || '未找到匹配标的'}
                        </p>
                      )}
                    </ScrollArea>
                  </div>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {config.execution_model === 'continuous_price'
                    ? '主连同时用于信号和模拟成交。'
                    : '主连产生信号，交易历史映射的实际合约。'}
                  股票数量单位为股，期货为手；商品期货请核对合约乘数。
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
                  日期可超出已有行情范围，回测使用区间内已收盘的可用 K
                  线，无数据时会提示。结束时间须晚于开始时间，跨度最多十年。
                </p>
                {numeric('初始资金（元）', config.initial_cash, (v) =>
                  field('initial_cash', v),
                )}
                {numeric('滑点（最小跳动数）', config.slippage_ticks, (v) =>
                  field('slippage_ticks', v),
                )}
                {numeric(
                  '成交量参与率（0–1）',
                  config.participation_rate,
                  (v) => field('participation_rate', v),
                )}
                <Label className="grid gap-2 text-xs">
                  基准标的（可留空）
                  <Input
                    value={config.benchmark_symbol ?? ''}
                    onChange={(e) =>
                      field('benchmark_symbol', e.target.value || null)
                    }
                  />
                </Label>
              </div>
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
                  value={optimization}
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
                  {numeric(
                    '每年交易日数',
                    config.annualization,
                    (v) => field('annualization', v),
                    '1',
                  )}
                  {numeric('年化无风险利率', config.risk_free_rate, (v) =>
                    field('risk_free_rate', v),
                  )}
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
