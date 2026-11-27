import { useEffect, useId, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { Label, Switch } from '@app/plugin-ui';
import { indexOptionSeries } from '../../option-families';
import { optionMode, optionModeName } from '../../option-selection';
import type { BacktestInput } from '../../strategy-types';

type Settings = NonNullable<BacktestInput['option_execution']>;
export const defaultOptionExecution: Settings = {
  mode: optionMode,
};

export function useOptionAvailability(pluginId: string, symbol: string) {
  const series = indexOptionSeries(symbol);
  const [match, setMatch] = useState<{ symbol: string; available: boolean }>();
  useEffect(() => {
    if (indexOptionSeries(symbol) || !symbol.includes('.')) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await pluginRequest<{ available: boolean }>(
          pluginId,
          `/sdk/option-availability?symbol=${encodeURIComponent(symbol)}`,
          { signal: abort.signal },
        );
        if (!abort.signal.aborted)
          setMatch({ symbol, available: result.available });
      } catch {
        if (!abort.signal.aborted) setMatch({ symbol, available: false });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [pluginId, symbol]);
  if (series) return true;
  if (!symbol.includes('.')) return false;
  return match?.symbol === symbol ? match.available : undefined;
}

export function OptionExecutionSettings(props: {
  value?: Settings;
  symbol: string;
  pluginId: string;
  onChange: (value?: Settings) => void;
}) {
  const available = useOptionAvailability(props.pluginId, props.symbol);
  return available ? <OptionExecutionFields {...props} /> : null;
}

export function OptionExecutionFields({
  value,
  onChange,
  symbol,
}: {
  value?: Settings;
  onChange: (value?: Settings) => void;
  symbol: string;
}) {
  const group = useId();
  const series = indexOptionSeries(symbol);

  return (
    <section
      aria-label="智能合约选择器"
      className="space-y-3 rounded-lg border border-border bg-card p-3.5"
    >
      <div className="flex items-center gap-2">
        <Label
          htmlFor={group + '-enabled'}
          className="flex-1 text-sm font-semibold"
        >
          智能合约选择器
        </Label>
        {value && series && (
          <span className="text-xs text-muted-foreground">
            {series.option} · 买方
          </span>
        )}
        <Switch
          id={group + '-enabled'}
          aria-label="自动选择期权"
          checked={!!value}
          onCheckedChange={(checked) =>
            onChange(checked ? defaultOptionExecution : undefined)
          }
        />
      </div>
      {value && (
        <div className="space-y-1">
          <p className="text-sm font-medium">{optionModeName}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            优先选时间价值占比最接近 1/3 的合约。并列时选当日累计成交量最接近
            1000 手的，到期周再按权利金接近 200 点择优。
          </p>
        </div>
      )}
    </section>
  );
}
