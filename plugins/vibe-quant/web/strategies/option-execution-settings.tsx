import { useEffect, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { indexOptionSeries } from '../../option-families';
import { Label, Slider, Switch } from '@app/plugin-ui';
import type { BacktestInput } from '../../strategy-types';

type Settings = NonNullable<BacktestInput['option_execution']>;
export const defaultOptionExecution: Settings = {
  target_leverage: 20,
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
}: {
  value?: Settings;
  onChange: (value?: Settings) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <Label className="flex items-center justify-between gap-3 text-sm">
        自动选择期权
        <Switch
          checked={!!value}
          onCheckedChange={(checked) =>
            onChange(checked ? defaultOptionExecution : undefined)
          }
        />
      </Label>
      {value && (
        <>
          <div className="flex justify-between text-xs">
            <span>目标有效杠杆</span>
            <span className="tabular-nums">{value.target_leverage} 倍</span>
          </div>
          <Slider
            min={1}
            max={Math.max(200, value.target_leverage)}
            step={1}
            value={[value.target_leverage]}
            thumbProps={{
              'aria-label': '目标有效杠杆',
              'aria-valuetext': `${value.target_leverage} 倍`,
            }}
            onValueChange={([target_leverage]) =>
              onChange({ ...value, target_leverage })
            }
          />
          <p className="text-xs leading-5 text-muted-foreground">
            有对应期权时，按倍率买入一手看涨或看跌合约。成交量不足跳过入场，无对应品种沿用原标的。
          </p>
        </>
      )}
    </div>
  );
}
