import { Badge } from '@app/plugin-ui';
import type { OrderBook } from '../shared';

const time = (value: number) =>
  new Date(value * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

export function OrderBookPanel({
  book,
  symbol,
  priceTick,
}: {
  book?: OrderBook;
  symbol: string;
  priceTick: number;
}) {
  const isIndex = /^(SSE\.000|SZSE\.399)/.test(symbol);
  const depth = book?.bidPrices.length ?? 0;
  const hasPrices =
    book &&
    [...book.bidPrices, ...book.askPrices].some((value) => value != null);
  const precision = Math.min(
    8,
    Math.max(2, (String(priceTick).split('.')[1] ?? '').length),
  );
  const formatPrice = (value: number | null | undefined) =>
    value == null
      ? '—'
      : value.toLocaleString('zh-CN', {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        });
  const formatVolume = (value: number | null | undefined) =>
    value == null
      ? '—'
      : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  return (
    <section aria-label="买卖盘口" className="min-w-0">
      <div className="flex items-center justify-between border-b px-4 py-4">
        <h2 className="text-sm font-medium">买卖盘口</h2>
        <Badge variant="outline">
          {isIndex ? '无盘口' : depth ? `${depth} 档` : '待同步'}
        </Badge>
      </div>
      {book && !isIndex ? (
        <>
          <table className="w-full text-xs tabular-nums">
            <caption className="sr-only">
              {symbol} 最近接收的买卖委托价格与数量
            </caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="px-4 py-3 text-left font-normal">
                  档位
                </th>
                <th scope="col" className="py-3 text-right font-normal">
                  价格
                </th>
                <th scope="col" className="px-4 py-3 text-right font-normal">
                  数量{book.volumeUnit === 'share' ? '（股）' : ''}
                </th>
              </tr>
            </thead>
            {(['ask', 'bid'] as const).map((side) => (
              <tbody key={side} className={side === 'bid' ? 'border-t' : ''}>
                {Array.from({ length: depth }, (_, index) =>
                  side === 'ask' ? depth - index - 1 : index,
                ).map((index) => (
                  <tr key={index}>
                    <th
                      scope="row"
                      className={`px-4 py-2.5 text-left font-normal ${side === 'ask' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                    >
                      {side === 'ask' ? '卖' : '买'}
                      {['一', '二', '三', '四', '五'][index]}
                    </th>
                    <td className="py-2.5 text-right font-medium">
                      {formatPrice(book[`${side}Prices`][index])}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {formatVolume(book[`${side}Volumes`][index])}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          <div className="space-y-2 border-t p-4 text-xs leading-5 text-muted-foreground">
            {!hasPrices && <p>数据源暂未返回有效盘口。</p>}
            <p>
              行情时间：
              {book.sourceTime == null ? '数据源未提供' : time(book.sourceTime)}
            </p>
            <p>接收时间：{time(book.receivedAt)}</p>
            {book.underlying && (
              <p className="break-all">当前标的：{book.underlying}</p>
            )}
            <p>
              {book.volumeUnit === 'source' ? '数量保留数据源单位。' : ''}
              缺失档位显示为 —。
            </p>
          </div>
        </>
      ) : (
        <p className="p-4 text-xs leading-6 text-muted-foreground">
          {isIndex
            ? '指数没有可交易的委托盘口。选择股票、期货或期权查看买卖档位。'
            : '等待盘口数据。档位数量取决于数据源、标的和行情权限。'}
        </p>
      )}
    </section>
  );
}
