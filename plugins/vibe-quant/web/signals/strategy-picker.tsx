import { strategyVersionName } from '../../strategy-version';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Input,
  ScrollArea,
} from '@app/plugin-ui';
import { InstrumentInput } from '../components/instrument-input';
import { durationLabel } from '../../shared';
import type { SignalMonitor } from '../../signal-types';
import {
  monitorExecutionModel,
  strategyHintDuration,
} from '../../signal-types';
import type { StrategySummary, StrategyVersion } from '../../strategy-types';
import { errorText } from '../strategies/format';

export function StrategyPicker({
  pluginId,
  symbolName,
  symbol,
  onClose,
  onCreated,
}: {
  pluginId: string;
  symbolName: string;
  symbol: string;
  onClose: () => void;
  onCreated: (item: SignalMonitor, strategy: StrategySummary) => void;
}) {
  const [items, setItems] = useState<StrategySummary[]>();
  const [sourceSymbol, setSourceSymbol] = useState(symbol);
  const [simulationEngine, setSimulationEngine] = useState<'builtin' | 'tqsdk'>(
    'builtin',
  );
  const [historyStart, setHistoryStart] = useState('');
  const [commission, setCommission] = useState('');
  const [margin, setMargin] = useState('');
  const [cash, setCash] = useState('1000000');
  const [defaults, setDefaults] = useState<{
    commission_per_lot?: number;
    margin_per_lot?: number;
  }>({});
  const native = simulationEngine === 'tqsdk';
  const [selected, setSelected] = useState('');
  const [primaryVersion, setPrimaryVersion] = useState<StrategyVersion>();
  const [canRun, setCanRun] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const version =
    primaryVersion?.strategy_id === selected ? primaryVersion : undefined;
  const versionDuration = strategyHintDuration(version?.parameters);
  const calculationDuration = versionDuration ?? 60;

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      pluginRequest<StrategySummary[]>(pluginId, '/strategies', {
        signal: abort.signal,
      }),
      pluginRequest<{ canRun: boolean }>(pluginId, '/strategies/template', {
        signal: abort.signal,
      }),
      pluginRequest<{ commission_per_lot?: number; margin_per_lot?: number }>(
        pluginId,
        '/strategies/simulation-defaults',
        { signal: abort.signal },
      ).catch(() => ({})),
    ])
      .then(([rows, permissions, simulationDefaults]) => {
        if (abort.signal.aborted) return;
        const usable = rows.filter(
          (row) =>
            row.status === 'active' && row.enabled && row.version_count > 0,
        );
        setDefaults(simulationDefaults);
        setItems(usable);
        setSelected(usable[0]?.id ?? '');
        setCanRun(permissions.canRun);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorText(error));
      });
    return () => abort.abort();
  }, [pluginId]);

  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void pluginRequest<StrategyVersion>(
      pluginId,
      `/strategies/${selected}/primary-version`,
      { signal: abort.signal },
    )
      .then((version) => {
        if (abort.signal.aborted) return;
        setPrimaryVersion(version);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorText(error));
      });
    return () => abort.abort();
  }, [pluginId, selected]);

  async function add() {
    const strategy = items?.find((item) => item.id === selected);
    if (!strategy || !version || busy) return;
    setBusy(true);
    setError('');
    try {
      const item = await pluginRequest<SignalMonitor>(
        pluginId,
        `/strategies/${strategy.id}/monitors`,
        {
          method: 'POST',
          body: JSON.stringify({
            symbol: sourceSymbol.trim(),
            display_symbol: symbol,
            simulation_engine: simulationEngine,
            ...(native
              ? {
                  initial_cash: Number(cash),
                  history_start: historyStart
                    ? Date.parse(`${historyStart}T00:00:00+08:00`) / 1000
                    : undefined,
                  tq_options: {
                    commission_per_lot:
                      commission === '' ? undefined : Number(commission),
                    margin_per_lot: margin === '' ? undefined : Number(margin),
                  },
                }
              : {}),
          }),
        },
      );
      onCreated(item, strategy);
      toast.success('已添加策略提示，开始计算全量历史并监听实时行情');
    } catch (error) {
      setError(errorText(error));
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90svh] flex-col">
        <DialogHeader>
          <DialogTitle>添加策略提示 · {symbolName}</DialogTitle>
          <DialogDescription>
            自动使用主要版本的默认参数
            {version ? `，按 ${durationLabel(calculationDuration)} 周期` : ''}
            {native
              ? '由天勤回放合约历史，随后持续模拟交易，成交与账户记录入库。'
              : '计算全部已存行情，完成后持续实时更新。'}
            {version &&
              (versionDuration !== undefined
                ? '计算周期取自主要版本参数，不受图表周期影响。'
                : '版本未配置周期，使用默认 1 分钟，不受图表周期影响。')}
            {!native &&
              monitorExecutionModel({ symbol: sourceSymbol }) === 'points' &&
              '指数按固定 1 单位模拟多空，收益以点数统计。'}
            {!native &&
              sourceSymbol.startsWith('KQ.m@') &&
              '主连按主连价格模拟，不计实际合约价差与换月成本。'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: 'max-h-[60svh] [&>div]:block!' }}
        >
          <div className="space-y-4 px-1">
            <InstrumentInput
              pluginId={pluginId}
              value={sourceSymbol}
              futuresOnly={native}
              onChange={setSourceSymbol}
              onSelect={(item) => setSourceSymbol(item.symbol)}
            />
            <p className="text-xs text-muted-foreground">
              信号显示在 {symbol}{' '}
              图表，策略使用上方标的计算。跨标的按时间标记信号，不绘制其他标的的价格线。
            </p>
            <Label className="grid gap-2">
              模拟引擎
              <Select
                value={simulationEngine}
                onValueChange={(v) =>
                  setSimulationEngine(v as 'builtin' | 'tqsdk')
                }
              >
                <SelectTrigger aria-label="模拟引擎">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="builtin">内置模拟</SelectItem>
                  <SelectItem value="tqsdk">天勤 TqSim</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            {native && (
              <div className="grid grid-cols-2 gap-3">
                <Label className="grid gap-2">
                  初始资金（元）
                  <Input
                    type="number"
                    value={cash}
                    onChange={(e) => setCash(e.target.value)}
                  />
                </Label>
                <Label className="grid gap-2">
                  历史起点（可留空）
                  <Input
                    type="date"
                    value={historyStart}
                    onChange={(e) => setHistoryStart(e.target.value)}
                  />
                </Label>
                <Label className="grid gap-2">
                  每手单边手续费（元）
                  <Input
                    type="number"
                    placeholder={
                      defaults.commission_per_lot === undefined
                        ? '使用天勤默认'
                        : `${defaults.commission_per_lot}（插件默认）`
                    }
                    value={commission}
                    onChange={(e) => setCommission(e.target.value)}
                  />
                </Label>
                <Label className="grid gap-2">
                  每手保证金（元）
                  <Input
                    type="number"
                    placeholder={
                      defaults.margin_per_lot === undefined
                        ? '使用天勤默认'
                        : `${defaults.margin_per_lot}（插件默认）`
                    }
                    value={margin}
                    onChange={(e) => setMargin(e.target.value)}
                  />
                </Label>
                <p className="col-span-2 text-xs text-muted-foreground">
                  仅支持实际期货合约。历史起点留空时查询最近十年内的合约历史。费用留空沿用插件默认，再回退到天勤默认；绩效指标使用天勤报告口径。
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {!items ? (
              <Skeleton className="h-9" />
            ) : items.length ? (
              <>
                <Label className="grid min-w-0 grid-cols-1 gap-2">
                  策略
                  <Select
                    value={selected}
                    disabled={busy}
                    onValueChange={(value) => {
                      setSelected(value);
                      setPrimaryVersion(undefined);
                      setError('');
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="选择提示策略">
                      <SelectValue className="min-w-0 truncate" />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Badge variant="secondary">主要版本</Badge>
                    {version ? `${strategyVersionName(version)}` : '正在加载…'}
                  </div>
                  {version?.note && (
                    <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {version.note}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    可在策略页面切换主要版本，添加时使用当前主要版本。
                  </p>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无可用策略，请先到
                <a
                  className="ml-1 underline"
                  href={`/plugins/${pluginId}/strategies`}
                >
                  策略页面
                </a>
                发布并启用一个版本。
              </p>
            )}
            {items && !canRun && (
              <p className="text-xs text-muted-foreground">
                运行策略需要管理员权限。
              </p>
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!version || !sourceSymbol.trim() || !canRun || busy}
            onClick={() => void add()}
          >
            {busy ? '正在添加…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
