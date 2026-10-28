import { useId, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@app/plugin-ui';
import { X } from 'lucide-react';
import type { FactorAnalysisInput } from '../../factor-types';
import { InstrumentInput } from '../components/instrument-input';

export function AnalysisForm({
  value,
  onChange,
  pluginId,
  disabled,
}: {
  value: FactorAnalysisInput;
  onChange: (value: FactorAnalysisInput) => void;
  pluginId: string;
  disabled: boolean;
}) {
  const [symbol, setSymbol] = useState('');
  const [batch, setBatch] = useState(false);
  const [batchText, setBatchText] = useState('');
  const inputId = useId();
  const update = <K extends keyof FactorAnalysisInput>(
    key: K,
    next: FactorAnalysisInput[K],
  ) => onChange({ ...value, [key]: next });
  const add = (next: string) => {
    const text = next.trim();
    if (text && !value.symbols.includes(text))
      update('symbols', [...value.symbols, text]);
    setSymbol('');
  };
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="mb-3 text-sm font-semibold">
        分析设置{' '}
        <Badge variant="outline" className="ml-2">
          期货 · 日线
        </Badge>
      </legend>
      <div className="grid grid-cols-2 gap-3">
        <Label className="grid gap-2 text-xs">
          开始日期
          <Input
            type="date"
            value={value.start}
            onChange={(e) => update('start', e.target.value)}
          />
        </Label>
        <Label className="grid gap-2 text-xs">
          结束日期
          <Input
            type="date"
            value={value.end}
            onChange={(e) => update('end', e.target.value)}
          />
        </Label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Label className="grid gap-2 text-xs">
          调仓周期
          <Input
            type="number"
            min={1}
            max={60}
            value={value.holding_days}
            onChange={(e) => update('holding_days', Number(e.target.value))}
            aria-label="调仓周期（交易日）"
          />
        </Label>
        <Label className="grid gap-2 text-xs">
          分组数
          <Input
            type="number"
            min={2}
            max={10}
            value={value.groups}
            onChange={(e) => update('groups', Number(e.target.value))}
          />
        </Label>
        <div className="grid gap-2">
          <Label className="text-xs">因子方向</Label>
          <Select
            disabled={disabled}
            value={String(value.direction)}
            onValueChange={(v) => update('direction', Number(v) as 1 | -1)}
          >
            <SelectTrigger className="w-full" aria-label="因子方向">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">正向</SelectItem>
              <SelectItem value="-1">反向</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={inputId} className="text-xs">
            合约池 · {value.symbols.length} 个
          </Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setBatchText(value.symbols.join('\n'));
              setBatch(!batch);
            }}
          >
            {batch ? '搜索添加' : '批量输入'}
          </Button>
        </div>
        {batch ? (
          <Textarea
            id={inputId}
            aria-label="批量合约代码"
            value={batchText}
            rows={4}
            placeholder={'每行一个完整代码，例如 KQ.m@SHFE.rb'}
            onChange={(e) => {
              setBatchText(e.target.value);
              update('symbols', [
                ...new Set(e.target.value.split(/[\s,，]+/).filter(Boolean)),
              ]);
            }}
          />
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <InstrumentInput
                pluginId={pluginId}
                futuresOnly
                includeContinuous
                label="添加期货合约"
                value={symbol}
                onChange={setSymbol}
                onSelect={(item) => add(item.symbol)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-6"
              disabled={!symbol.trim() || value.symbols.length >= 50}
              onClick={() => add(symbol)}
            >
              添加
            </Button>
          </div>
        )}
        {!batch && (
          <div className="flex flex-wrap gap-1.5">
            {value.symbols.map((item) => (
              <Badge
                key={item}
                variant="secondary"
                className="max-w-full gap-1 font-mono text-xs"
              >
                <span className="truncate">{item}</span>
                <button
                  type="button"
                  aria-label={`移除 ${item}`}
                  className="rounded-sm p-0.5 hover:bg-muted focus-visible:outline-2"
                  onClick={() =>
                    update(
                      'symbols',
                      value.symbols.filter((s) => s !== item),
                    )
                  }
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          选择至少 3
          个期货或主力连续合约，数量须不少于分组数。仅分析已采集的日线行情。
        </p>
      </div>
    </fieldset>
  );
}
