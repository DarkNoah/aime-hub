import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  JsonObjectEditor,
  ScrollArea,
  Skeleton,
} from '@app/plugin-ui';
import { toast } from 'sonner';
import type { SignalMonitor } from '../../signal-types';
import { runVersionName } from '../../strategy-version';
import { errorText, parseObject } from '../strategies/format';

type Parameters = Record<string, unknown>;
interface ParameterSnapshot {
  defaults: Parameters;
  current: Parameters;
  revision: number;
  canEdit: boolean;
}
export type NamedMonitor = SignalMonitor & { strategy_name: string };

export function MonitorParameterFields({
  value,
  onChange,
  defaults,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  defaults: Parameters;
  readOnly: boolean;
}) {
  return (
    <section className="min-w-0 space-y-3">
      <JsonObjectEditor
        label="策略参数"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          duration 为计算周期（秒）。省略的参数沿用此版本的默认值。
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={readOnly}
          onClick={() => onChange(JSON.stringify(defaults, null, 2))}
        >
          恢复版本默认值
        </Button>
      </div>
    </section>
  );
}

export function MonitorParametersDialog({
  pluginId,
  item,
  busy,
  onClose,
  onSave,
}: {
  pluginId: string;
  item: NamedMonitor;
  busy: boolean;
  onClose: () => void;
  onSave: (parameters: Parameters, revision: number) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<ParameterSnapshot>();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void pluginRequest<ParameterSnapshot>(
      pluginId,
      `/strategies/monitors/${item.id}/parameters`,
      { signal: abort.signal },
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        setValue(JSON.stringify(result.current, null, 2));
        setSnapshot(result);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(errorText(cause));
      });
    return () => abort.abort();
  }, [pluginId, item.id]);

  async function save() {
    if (!snapshot || busy) return;
    try {
      await onSave(parseObject(value), snapshot.revision);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90svh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>策略参数 · {item.strategy_name}</DialogTitle>
          <DialogDescription>
            {item.config.symbol} · {runVersionName(item)}
            。修改仅用于本条策略监听。
            {item.enabled
              ? '应用后将从历史起点重新计算信号和持仓。'
              : '当前已暂停，启用计算后将从历史起点重新计算。'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="min-h-0 flex-1"
          viewportProps={{ className: 'max-h-[60svh] [&>div]:block!' }}
        >
          {snapshot ? (
            <MonitorParameterFields
              value={value}
              onChange={setValue}
              defaults={snapshot.defaults}
              readOnly={busy || !snapshot.canEdit}
            />
          ) : error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <Skeleton className="h-24" />
          )}
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {snapshot?.canEdit && (
            <Button
              disabled={
                busy || value === JSON.stringify(snapshot.current, null, 2)
              }
              onClick={() => void save()}
            >
              {busy
                ? '正在保存…'
                : item.enabled
                  ? '应用并重新计算'
                  : '保存参数'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
