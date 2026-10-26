import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@app/plugin-ui';
import type { RiskLevelRecord, TradeRecord } from '../../strategy-types';
import { tradeExitAnchor } from '../../strategy-types';
import { exitReasonLabel } from '../trade-exit';
import { readChartPeriod } from '../chart-period';
import { MarketChartPanel } from '../components/market-chart-panel';
import { dateTime, number } from './format';
import { useMarketBars } from '../use-market-bars';
import { tradeRiskLevels } from '../trade-risk';
import { TradeRiskHistory } from './trade-risk-history';

const EMPTY_RISK_LEVELS: RiskLevelRecord[] = [];

export default function TradeView({
  pluginId,
  runId,
  trade,
  riskLevels = EMPTY_RISK_LEVELS,
  onClose,
}: {
  pluginId: string;
  runId: string;
  trade: TradeRecord;
  riskLevels?: RiskLevelRecord[];
  onClose: () => void;
}) {
  const [period, setPeriod] = useState(readChartPeriod);
  const [retry, setRetry] = useState(0);
  const [showRisk, setShowRisk] = useState(true);
  const exitTime = tradeExitAnchor(trade);
  const levels = useMemo(
    () => tradeRiskLevels(trade, riskLevels),
    [trade, riskLevels],
  );
  const sharedScope = `backtest:${runId}:${trade.symbol}`;
  const view = useMarketBars({
    pluginId,
    symbol: trade.symbol,
    duration: period === 'intraday' ? 60 : period,
    intraday: period === 'intraday',
    identity: `${sharedScope}:${trade.id}:${period}`,
    retry,
    barsPath: `/strategies/runs/${runId}/trades/${encodeURIComponent(trade.id)}/bars`,
    initialTime: trade.entry_time,
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-[min(1400px,95vw)]">
        <SheetHeader className="border-b p-5">
          <SheetTitle className="flex flex-wrap items-center gap-2 pr-6">
            {trade.symbol}
            <Badge variant="outline">
              {trade.side === 'long' ? '多头' : '空头'} · {trade.quantity}
            </Badge>
            {trade.status === 'open' && (
              <Badge variant="secondary">未平仓</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {trade.status === 'open'
              ? '回测结束时仍未平仓 · 蓝色标记为入场位置'
              : '蓝色入场 / 橙色离场'}
            {' · 拖动图表继续加载前后行情'}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <Button
              size="sm"
              variant="outline"
              disabled={view.loading}
              title={dateTime(trade.entry_time)}
              onClick={() => void view.navigate(trade.entry_time)}
            >
              定位入场 {number(trade.entry_price)}
            </Button>
            {exitTime !== null && (
              <Button
                size="sm"
                variant="outline"
                disabled={view.loading}
                title={dateTime(trade.exit_time)}
                onClick={() => void view.navigate(exitTime)}
              >
                定位离场 {number(trade.exit_price)}
              </Button>
            )}
            {trade.status !== 'open' && (
              <Badge variant="outline" title={trade.exit_reason}>
                离场原因：{exitReasonLabel(trade.exit_reason)}
              </Badge>
            )}
            {trade.trigger_price != null && (
              <span className="text-xs text-muted-foreground">
                触发价 {number(trade.trigger_price)}
              </span>
            )}
            <span className="ml-auto text-xs tabular-nums">
              {trade.status === 'open'
                ? `未平仓数量 ${trade.quantity}`
                : `净收益 ${number(trade.net_pnl)}`}
            </span>
          </div>
          {trade.exit_time_precision === 'bar' && (
            <p className="border-b px-4 py-2 text-xs text-muted-foreground">
              该根 K 线内触发自动平仓，记录时间为 {dateTime(trade.exit_time)}（K
              线结束）；图中标记定位成交所属 K 线。
            </p>
          )}
          {trade.trigger_bar_time != null &&
            trade.trigger_bar_time !== trade.exit_bar_time && (
              <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                于 {dateTime(trade.trigger_time)} 触发，受成交量或 T+1
                限制延后成交；平仓沿用触发时的原因和价格依据。
              </p>
            )}
          <TradeRiskHistory
            records={levels}
            triggeredId={trade.risk_level_id}
            visible={showRisk}
            onVisibleChange={setShowRisk}
            onNavigate={(time) => void view.navigate(time)}
          />
          <div className="flex h-[calc(100dvh-16rem)] min-h-[640px] flex-col">
            <MarketChartPanel
              view={view}
              identity={`${sharedScope}:${period}`}
              drawingSharedScope={sharedScope}
              period={period}
              onPeriodChange={setPeriod}
              priceTick={view.priceTick ?? 0.01}
              volumeProfileSource={{
                pluginId,
                path: `/strategies/runs/${runId}/trades/${encodeURIComponent(trade.id)}/volume-profile`,
              }}
              trade={trade}
              riskLevels={showRisk ? levels : EMPTY_RISK_LEVELS}
              emptyHint="正在读取实际成交合约的行情，拖动至边缘可继续加载。"
            />
          </div>
          {view.error && (
            <Button
              size="sm"
              variant="outline"
              className="m-3"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新加载行情
            </Button>
          )}
          <p className="border-t px-4 py-3 text-[11px] leading-5 text-muted-foreground">
            K
            线使用行情库当前数据，可继续浏览回测区间以外的行情；成交标记取自本次回测记录。
          </p>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
