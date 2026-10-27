import { useEffect, useId, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import { AutocompleteInput, Label } from '@app/plugin-ui';
import type { Instrument } from '../../shared';
import { errorText } from '../strategies/format';

export function InstrumentInput({
  pluginId,
  value,
  futuresOnly = false,
  onChange,
  onSelect,
}: {
  pluginId: string;
  value: string;
  futuresOnly?: boolean;
  onChange: (value: string) => void;
  onSelect: (instrument: Instrument) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const query = value.trim();
  const searchKey = JSON.stringify([pluginId, query, futuresOnly]);
  const [result, setResult] = useState<{
    key: string;
    items: Instrument[];
    error?: string;
  }>();
  // Hide results from the previous query immediately, including during debounce.
  const current = query && result?.key === searchKey ? result : undefined;
  const matches = current?.items ?? [];

  useEffect(() => {
    if (!open || !query) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const rows = await pluginRequest<Instrument[]>(
          pluginId,
          `/instruments?q=${encodeURIComponent(query)}${futuresOnly ? '&kind=future' : ''}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setResult({
          key: searchKey,
          items: rows
            .filter((item) =>
              futuresOnly ? item.kind === 'future' : item.kind !== 'option',
            )
            .slice(0, 12),
        });
      } catch (error) {
        if (!abort.signal.aborted) {
          setResult({ key: searchKey, items: [], error: errorText(error) });
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [pluginId, query, futuresOnly, searchKey, open]);

  const status = !query
    ? '输入标的代码或名称，自动搜索匹配标的'
    : !current
      ? open
        ? '正在搜索标的…'
        : '输入代码或名称以搜索标的'
      : current.error
        ? `搜索失败：${current.error}。可继续输入完整标的代码。`
        : !matches.length
          ? '未找到匹配标的，可直接输入完整代码'
          : undefined;

  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id} className="text-xs">
        信号标的
      </Label>
      <AutocompleteInput
        id={id}
        required
        value={value}
        options={matches.map((item) => ({
          value: item.symbol,
          label: item.name,
        }))}
        open={open}
        onOpenChange={setOpen}
        onValueChange={onChange}
        onSelect={(symbol) => {
          const item = matches.find((match) => match.symbol === symbol);
          if (item) onSelect(item);
        }}
        placeholder={
          futuresOnly
            ? '输入实际合约代码或名称，如 IM2611、螺纹钢'
            : '输入代码或名称，如 IM、螺纹钢、600000'
        }
        status={status}
      />
    </div>
  );
}
