import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@app/plugin-ui';
import type { BacktestInput } from '../../strategy-types';

type Fees = BacktestInput['rules']['fees'];

export function FeeSettings({
  value,
  onChange,
}: {
  value: Fees;
  onChange: (fees: Fees) => void;
}) {
  const mode = value.mode ?? 'combined';
  const update = <K extends keyof Fees>(key: K, next: Fees[K]) =>
    onChange({ ...value, [key]: next });
  const amount = (
    key: Exclude<keyof Fees, 'mode'>,
    label: string,
    optional = false,
  ) => (
    <Label className="grid gap-2 text-xs">
      {label}
      <Input
        type="number"
        min="0"
        step="any"
        required={!optional}
        value={value[key] ?? ''}
        onChange={(event) =>
          update(
            key,
            optional && event.target.value === ''
              ? null
              : event.target.valueAsNumber,
          )
        }
      />
    </Label>
  );

  return (
    <div className="space-y-4 border-t pt-4">
      <Label className="grid gap-2 text-xs">
        手续费模式
        <Select
          value={mode}
          onValueChange={(next) => update('mode', next as Fees['mode'])}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">固定手续费（按手／股）</SelectItem>
            <SelectItem value="rate">按成交额比例</SelectItem>
            <SelectItem value="combined">组合计费（固定 + 比例）</SelectItem>
          </SelectContent>
        </Select>
      </Label>
      <p className="text-xs leading-5 text-muted-foreground">
        {mode === 'fixed'
          ? '手续费 = 成交手数／股数 × 固定金额，不随成交价格变化。开仓和平仓分别收取。'
          : mode === 'rate'
            ? '手续费 = 成交额 × 费率；期货成交额包含合约乘数。开仓和平仓分别收取。'
            : '手续费 = 成交手数／股数 × 固定金额 + 成交额 × 费率。开仓和平仓分别收取。'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {mode !== 'rate' && (
          <>
            {amount('per_unit', '每手／股固定手续费（元）')}
            {amount(
              'close_today_per_unit',
              '平今每手／股固定手续费（元，空则沿用）',
              true,
            )}
          </>
        )}
        {mode !== 'fixed' && (
          <>
            {amount('rate', '成交额手续费率')}
            {amount('close_today_rate', '平今手续费率（空则沿用）', true)}
          </>
        )}
        {amount('minimum', '最低手续费（元）')}
        {amount('sell_tax_rate', '卖出税率')}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        每次成交片段的手续费至少为最低手续费，卖出税费另计；平今费用留空时沿用普通费用，填
        0 表示免收该项。费率使用小数，0.0001 表示万分之一。
      </p>
    </div>
  );
}
