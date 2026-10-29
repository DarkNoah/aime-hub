import { Badge } from '@app/plugin-ui';
import { ExternalLink } from 'lucide-react';
import type { BuiltinFactorInfo } from '../../factor-types';

const fieldNames: Record<string, string> = {
  amount: '成交额',
  vwap: '真实 VWAP',
  cap: '市值',
  sector: '板块分类',
  industry: '行业分类',
  subindustry: '细分行业',
  benchmark_open: '基准指数开盘价',
  benchmark_close: '基准指数收盘价',
  mkt: 'MKT',
  smb: 'SMB',
  hml: 'HML',
};
export function BuiltinInfo({ info }: { info: BuiltinFactorInfo }) {
  const extra = info.fields.filter((field) => field in fieldNames);
  return (
    <details className="rounded-md border p-3 text-xs" open>
      <summary className="cursor-pointer font-medium">公式与计算口径</summary>
      <div className="mt-3 space-y-3 leading-5">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">内置 v1</Badge>
          <Badge variant="outline">
            {info.cross_sectional ? '横截面因子' : '时序因子'}
          </Badge>
          <Badge variant="outline">预热 {info.lookback} 根</Badge>
          {extra.length > 0 && <Badge variant="outline">需要扩展数据</Badge>}
        </div>
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {info.formula}
        </p>
        {extra.length > 0 && (
          <p>
            需要：{extra.map((f) => fieldNames[f]).join('、')}
            。当前行情未提供必要字段时会停止计算。
          </p>
        )}
        {info.cross_sectional && (
          <p>
            按所选合约池的同日数据计算排名或中性化；更换合约池会改变因子值。策略单合约
            value() 不适用。
          </p>
        )}
        {info.recursive && (
          <p>
            递推公式使用最近 500 根历史；SMA
            以首个有效输入初始化。分析与单合约调用采用相同窗口。
          </p>
        )}
        {info.notes.length > 0 && (
          <ul className="list-disc space-y-1 pl-4">
            {info.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <a
          className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
          href={info.reference}
          target="_blank"
          rel="noreferrer"
        >
          查看公式来源
          <ExternalLink className="size-3" />
        </a>
      </div>
    </details>
  );
}
