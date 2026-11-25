import { useEffect, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { indexOptionSeries } from '../../option-families';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from '@app/plugin-ui';
import {
  defaultIv,
  ivLimits,
  ivNames,
  ivPreferenceIds,
  optionProfiles,
  profileIds,
  profileNames,
  type IvPreference,
  type OptionProfile,
} from '../../option-selection';
import type { BacktestInput } from '../../strategy-types';

type Settings = NonNullable<BacktestInput['option_execution']>;
export const defaultOptionExecution: Settings = {
  profile: 'balanced',
  target_leverage: optionProfiles.balanced.target_leverage,
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

const profileDescription = {
  moderate: '优先偏实值合约，权利金的点数变化更贴近标的。',
  balanced: '优先近平值合约，兼顾方向跟随和杠杆。',
  aggressive: '优先偏虚值合约，权利金较低，更依赖标的大幅波动。',
} satisfies Record<OptionProfile, string>;

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
  const profile = value?.profile;
  const preset = profile && optionProfiles[profile];
  const iv = profile && (value?.iv_preference ?? defaultIv(profile));
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
        <>
          <fieldset className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
            <legend className="sr-only">选约风格</legend>
            {profileIds.map((id) => (
              <label key={id} className="cursor-pointer">
                <input
                  type="radio"
                  name={group}
                  value={id}
                  checked={profile === id}
                  className="peer sr-only"
                  onChange={() =>
                    onChange({
                      profile: id,
                      target_leverage: optionProfiles[id].target_leverage,
                    })
                  }
                />
                <span className="flex min-h-8 items-center justify-center rounded-sm text-sm text-muted-foreground hover:text-foreground peer-checked:bg-primary peer-checked:font-semibold peer-checked:text-primary-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {profileNames[id]}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs leading-5 text-muted-foreground">
            {profile
              ? profileDescription[profile]
              : '仅按倍率选择有足够成交量的合约。'}
          </p>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-xs">
              <span>目标有效杠杆</span>
              <span className="font-semibold tabular-nums">
                {value.target_leverage} 倍
              </span>
            </div>
            <Slider
              className="py-2"
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
          </div>
          {preset && iv && (
            <details className="group border-t pt-2 text-xs">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 group-open:rotate-90"
                />
                选约细节
              </summary>
              <div className="mt-3 space-y-2">
                <Label className="flex items-center justify-between gap-2 text-xs">
                  IV 容忍度
                  <Select
                    value={iv}
                    onValueChange={(next) =>
                      onChange({
                        ...value,
                        iv_preference: next as IvPreference,
                      })
                    }
                  >
                    <SelectTrigger className="h-8" aria-label="IV 容忍度">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ivPreferenceIds.map((id) => (
                        <SelectItem key={id} value={id}>
                          {ivNames[id]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <p className="leading-5 text-muted-foreground">
                  |Delta| {preset.delta_min.toFixed(2)}–
                  {preset.delta_max.toFixed(2)}，IV
                  最高为同到期、同方向合约当分钟中位数的{' '}
                  {Math.round(ivLimits[iv] * 100)}
                  %。至少需要三个有足够成交量的行权价。
                </p>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() =>
                    onChange({ target_leverage: value.target_leverage })
                  }
                >
                  仅按倍率选择
                </Button>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
