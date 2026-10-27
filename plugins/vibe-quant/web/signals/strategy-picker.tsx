import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
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
} from '@app/plugin-ui';
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
  const [selected, setSelected] = useState('');
  const [versions, setVersions] = useState<{
    strategyId: string;
    items: StrategyVersion[];
  }>();
  const [versionId, setVersionId] = useState('');
  const [canRun, setCanRun] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const availableVersions =
    versions?.strategyId === selected ? versions.items : undefined;
  const version = availableVersions?.find((item) => item.id === versionId);
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
    ])
      .then(([rows, permissions]) => {
        if (abort.signal.aborted) return;
        const usable = rows.filter(
          (row) =>
            row.status === 'active' && row.enabled && row.version_count > 0,
        );
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
    void pluginRequest<StrategyVersion[]>(
      pluginId,
      `/strategies/${selected}/versions`,
      { signal: abort.signal },
    )
      .then((rows) => {
        if (abort.signal.aborted) return;
        const sorted = [...rows].sort((a, b) => b.number - a.number);
        setVersions({ strategyId: selected, items: sorted });
        setVersionId(sorted[0]?.id ?? '');
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
          body: JSON.stringify({ version_id: version.id, symbol }),
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加策略提示 · {symbolName}</DialogTitle>
          <DialogDescription>
            使用所选版本的默认参数
            {version ? `，按 ${durationLabel(calculationDuration)} 周期` : ''}
            计算全部已存行情，完成后持续实时更新。
            {version &&
              (versionDuration !== undefined
                ? '计算周期取自所选版本参数，不受图表周期影响。'
                : '版本未配置周期，使用默认 1 分钟，不受图表周期影响。')}
            {monitorExecutionModel({ symbol }) === 'points' &&
              '指数按固定 1 单位模拟多空，收益以点数统计。'}
            {symbol.startsWith('KQ.m@') &&
              '主连按主连价格模拟，不计实际合约价差与换月成本。'}
          </DialogDescription>
        </DialogHeader>
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
                  setVersionId('');
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
            <Label className="grid min-w-0 grid-cols-1 gap-2">
              版本
              <Select
                value={versionId}
                disabled={busy || !availableVersions?.length}
                onValueChange={setVersionId}
              >
                <SelectTrigger className="w-full" aria-label="选择策略版本">
                  <SelectValue
                    placeholder={
                      !availableVersions ? '正在加载版本…' : '暂无已发布版本'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableVersions?.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      v{item.number}
                      {item.note ? ` · ${item.note}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
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
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!version || !canRun || busy}
            onClick={() => void add()}
          >
            {busy ? '正在添加…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
